import { readFileSync } from 'node:fs';
import type { RainverPlugin, PluginOperationContext, PluginOperationId } from '@rainver/protocol';
import {input,probeManifest,jobId,proposalType} from './manifest.js';
export {jobId,proposalType} from './manifest.js';
/**
 * A consumer written against the original `onDispose` contract (no `retain`,
 * no closing point): its handler returns first, then it creates a resource
 * and registers that resource's dispose through the saved context. The test
 * supplies when the resource is created and how its dispose behaves. Passing
 * one registers the probe's Job under the original contract; without it the
 * probe uses the bounded contract (`disposeRegistration: 'handler'`), as every
 * in-repository producer does.
 */
export interface LegacyResourceConsumer {
  create(): Promise<{ dispose(): Promise<void> | void }>;
  registered?(dispose: () => Promise<void>): void;
}
export function createLifecycleProbe(observe: (value: string) => void = () => {}, legacy?: LegacyResourceConsumer): RainverPlugin {
  const manifest=probeManifest;
  const write = async (raw: unknown, ctx: PluginOperationContext) => {
    const args = input.parse(raw);
    await ctx.db.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2) ON CONFLICT(space_id,user_id,key) DO UPDATE SET value=EXCLUDED.value", [args.key, args.value]);
    return {
      values: [args.value]
    };
  };
  return {
    id: manifest.id,
    version: manifest.version,
    operationManifest: manifest,
    migrations: [{
      id: '0000_unusual_joseph',
      sql: readFileSync(new URL('./migrations/0000_unusual_joseph.sql', import.meta.url), 'utf8')
    }],
    activate(ctx) {
      for (const op of manifest.operations) ctx.actions!.register(op.id as PluginOperationId, async (raw, call) => {
        if (op.id.endsWith('.enqueue')) return call.jobs!.enqueue(jobId, {
          value: input.parse(raw).value
        });
        if (op.kind === 'command') return write(raw, call);
        return {
          values: (await call.db.query<{
            value: string;
          }>("SELECT value FROM records WHERE space_id=current_setting('rainver.space_id') AND user_id=current_setting('rainver.user_id') ORDER BY key")).rows.map(r => r.value)
        };
      });
      ctx.lifecycle!.proposals.register(proposalType, write);
      ctx.lifecycle!.jobs.register(jobId, async (payload, call) => {
        const args = payload as {
          value: string;
          hold?: boolean;
          late?: boolean;
          retain?: boolean;
          legacy?: boolean;
          dispose_in_txn?: boolean;
        };
        call.onDispose(() => observe('first'));
        call.onDispose(() => observe('second'));
        observe('started');
        if (args.hold) await call.db.query('SELECT pg_sleep(30)').catch(async (error: unknown) => {
          // A Job still running after its hold's drain began registers one more resource.
          if (args.late) {
            await new Promise(resolve => setTimeout(resolve, 50));
            call.onDispose(() => observe('late'));
          }
          throw error;
        });
        if (args.retain) {
          // A resource that outlives the handler: its durable obligation is reserved before it exists.
          const kept = await call.retain();
          kept.onDispose(() => observe('retained'));
          kept.release();
        }
        if (args.legacy && legacy) {
          // Original order: resource after the handler returned, then the saved context registers it.
          void (async () => {
            const resource = await legacy.create();
            legacy.registered?.(call.onDispose(() => resource.dispose()));
          })();
        } else if (args.legacy) {
          // The same order under the bounded contract breaks it: the registration after the handler settled is refused.
          void (async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            try { call.onDispose(() => observe('after-return')); observe('after-return-registered'); } catch (error) { observe(`after-return-refused:${(error as Error).name}`); }
          })();
        }
        if (args.dispose_in_txn) {
          // An early dispose requested inside the Job's transaction: refused, never run there.
          const early = call.onDispose(() => observe('txn-disposed'));
          await early().then(() => observe('in-txn-resolved'), (error: Error) => observe(`in-txn-refused:${error.name}`));
        }
        call.signal.throwIfAborted();
        await call.db.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2) ON CONFLICT DO NOTHING", [`job:${call.jobId}`, args.value]);
        return {
          written: true
        };
      }, legacy ? undefined : { disposeRegistration: 'handler' });
      ctx.lifecycle!.schedules.register('plugin.operation_probe.schedule.write', async () => ({
        value: 'scheduled'
      }));
      return {
        activated: true
      };
    }
  };
}
export default createLifecycleProbe();
