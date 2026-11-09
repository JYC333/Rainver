import type { RainverPlugin, PluginScope, PluginOperationManifest } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import type { ScheduledTask } from '../scheduler/registry.js';
import { getDbPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { runOperationWork } from '../../db/operationTransaction.js';
import { assertCurrentActor, sessionActor } from '../systemActions/operations/actor.js';
import { operationPluginEnabled, lockOperationPluginScope } from './operationEnablement.js';
import { PgJobQueueRepository } from '../jobs/repository.js';
import { withPolicyAuditRecovery } from '../policy/auditWriter.js';
import { enforce } from '../policy/service.js';
import { loadActionRegistry } from '../policy/actionRegistry.js';
export function pluginSchedule(config: ServerConfig, plugin: RainverPlugin, declared: NonNullable<PluginOperationManifest['schedules']>[number], payload: (scope: PluginScope) => Promise<Record<string, unknown>>, active: () => boolean): ScheduledTask {
  return {
    name: declared.id,
    intervalSeconds: declared.intervalSeconds,
    runOnStart: declared.runOnStart,
    run: async () => {
      if (!active()) return;
      const pool = getDbPool(config.databaseUrl!),
        m = plugin.operationManifest!,
        errors: unknown[] = [];
      const rows = (await pool.query<{
        space_id: string | null;
        user_id: string | null;
        enabled_by_user_id: string | null;
      }>("SELECT space_id,user_id,enabled_by_user_id FROM official_plugin_enablements WHERE plugin_id=$1 AND enabled=true AND (($2::text='space' AND space_id IS NOT NULL AND user_id IS NULL) OR ($2::text='user' AND space_id IS NULL AND user_id IS NOT NULL))", [m.id, m.scope])).rows;
      for (const row of rows) {
        const scopes: PluginScope[] = row.space_id ? [{
          spaceId: row.space_id,
          userId: row.enabled_by_user_id ?? ''
        }] : (await pool.query<{
          space_id: string;
        }>('SELECT space_id FROM space_memberships WHERE user_id=$1 AND status=\'active\' ORDER BY space_id', [row.user_id])).rows.map(r => ({
          spaceId: r.space_id,
          userId: row.user_id!
        }));
        for (const scope of scopes) {
          if (!scope.userId) continue;
          try {
            const queued = await withPolicyAuditRecovery(config.databaseUrl, () => withTransaction(pool, async client => {
              // Freeze the schedule's responsible person; never substitute an arbitrary owner.
              const authority=await client.query("SELECT 1 FROM users u JOIN space_memberships sm ON sm.user_id=u.id WHERE u.id=$1 AND u.status='active' AND sm.space_id=$2 AND sm.status='active'",[scope.userId,scope.spaceId]);
              if(authority.rows.length)await assertCurrentActor(client,sessionActor(scope),true);
              await lockOperationPluginScope(client, m.id, scope.spaceId, scope.userId, config);
              if (!(await operationPluginEnabled(client, m.id, scope.spaceId, scope.userId, config))) return false;
              await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`plugin-schedule:${declared.job}:${m.scope}:${m.scope==='space'?scope.spaceId:scope.userId}`]);
              if(!authority.rows.length){
               await client.query("INSERT INTO official_plugin_events(id,plugin_id,space_id,target_user_id,event_type,metadata_json,created_at) SELECT gen_random_uuid(),$1::varchar,$2::varchar,$3::varchar,'schedule_authority_paused',$4::jsonb,now() WHERE NOT EXISTS(SELECT 1 FROM official_plugin_events WHERE plugin_id=$1 AND event_type='schedule_authority_paused' AND metadata_json=$4::jsonb AND space_id=$2 AND target_user_id=$3)",[m.id,scope.spaceId,scope.userId,JSON.stringify({schedule:declared.id})]);
               return false;
              }
              const decision = await enforce({
                ...config,
                auditTransaction: client
              }, await loadActionRegistry(config), {
                action: declared.job,
                actor_type: 'system',
                actor_id: `plugin.${m.id}`,
                space_id: scope.spaceId,
                resource_space_id: scope.spaceId,
                resource_type: `plugin.${m.id}`,
                resource_id: scope.userId,
                force_record: true,
                context: {
                  trigger_origin: 'automation',
                  instructed_by_user_id: scope.userId
                }
              });
              if (decision.status !== 'allow') throw new Error('Plugin schedule policy denied');
              const job = m.jobs!.find(j => j.id === declared.job)!;
              const intent=job.payload_schema.parse(await runOperationWork(() => payload(scope)));
              const pending=await client.query("SELECT 1 FROM jobs WHERE job_type=$1 AND status IN ('pending','claimed','running') AND (($2='space' AND space_id=$3) OR ($2='user' AND user_id=$4)) AND payload_json=$5::jsonb LIMIT 1",[declared.job,m.scope,scope.spaceId,scope.userId,JSON.stringify(intent)]);
              if(pending.rows.length)return true;
              await new PgJobQueueRepository(client).enqueue({
                job_type: declared.job,
                space_id: scope.spaceId,
                user_id: scope.userId,
                payload: intent
              });
              return true;
            }));
            // User scope follows the person: one pass in the first currently eligible Space, not one Job per membership.
            if (queued) break;
          } catch (e) {
            errors.push(e);
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Plugin schedule scope failures');
    }
  };
}
