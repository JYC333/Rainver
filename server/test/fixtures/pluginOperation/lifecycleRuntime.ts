import { readFileSync } from 'node:fs';
import type { RainverPlugin, PluginOperationContext, PluginOperationId } from '@rainver/protocol';
import {input,probeManifest,jobId,proposalType} from './manifest.js';
export {jobId,proposalType} from './manifest.js';
export function createLifecycleProbe(observe: (value: string) => void = () => {}): RainverPlugin {
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
        };
        call.onDispose(() => observe('first'));
        call.onDispose(() => observe('second'));
        observe('started');
        if (args.hold) await call.db.query('SELECT pg_sleep(30)');
        call.signal.throwIfAborted();
        await call.db.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2) ON CONFLICT DO NOTHING", [`job:${call.jobId}`, args.value]);
        return {
          written: true
        };
      });
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
