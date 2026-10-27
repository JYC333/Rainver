import { throwIfAnyFailed } from '../../scheduler/registry.js';
import { recoverMonitoringCoordinators } from './coordinatorRecovery.js';
import { localMonitoringDate } from '../../projects/monitoringControl.js';
import type { Queryable } from '../../routeUtils/common.js';
import { HttpError, withQueryableTransaction } from '../../routeUtils/common.js';
import type { ServerConfig } from '../../../config.js';
import { PgSchedulerTaskStore } from '../../scheduler/taskStore.js';
import { ProjectMonitoringService } from '../../projects/monitoring/service.js';
import { ProjectMonitoringConfigSchema } from '@rainver/protocol';
import { computeNextRunAt } from '../../automations/schedule.js';
import { MONITORING_TASK, monitoringCron } from './schedule.js';

/** Existing Sources heartbeat dispatches durable Jobs. No IO or new timing loop here. */
export async function enqueueDueMonitoring(db: Queryable, config: ServerConfig, now = new Date()) {
  const failures: unknown[] = [];
  try {
    await recoverMonitoringCoordinators(db, config);
  } catch (error) {
    failures.push(error);
  }
  const store = new PgSchedulerTaskStore(db);
  const due = await store.listDue(MONITORING_TASK, now.toISOString(), 25, {respectRetryAfter:true}).catch(async (error: unknown) => {
    failures.push(error);
    return [];
  });
  for (const candidate of due) await withQueryableTransaction(db, async tx => {
    // Match Project -> scheduler order used by activation; re-read after locking.
    await tx.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE`, [candidate.task_key, candidate.space_id]);
    const task = await tx.query<{
      user_id: string;
      next_run_at: string;
      metadata_json: Record<string, unknown>;
    }>(`SELECT user_id,next_run_at,metadata_json FROM scheduler_tasks WHERE id=$1 AND status='active' AND next_run_at<=$2 FOR UPDATE`, [candidate.id, now.toISOString()]);
    const row = task.rows[0];
    if (!row || !candidate.space_id) return;
    const version = await tx.query<{
      id: string;
      config_hash: string;
      config_json: unknown;
    }>(`SELECT v.id,v.config_hash,v.config_json FROM projects p JOIN project_information_monitoring_versions v ON v.id=p.active_information_monitoring_version_id AND v.space_id=p.space_id WHERE p.id=$1 AND p.space_id=$2 AND p.status='active'`, [candidate.task_key, candidate.space_id]);
    if (!version.rows[0]) throw new HttpError(409, 'Monitoring version unavailable');
    const v = version.rows[0],
      cfg = ProjectMonitoringConfigSchema.parse(v.config_json);
    if (!cfg.schedule) throw new HttpError(409, 'Monitoring schedule unavailable');
    try {
      await new ProjectMonitoringService(tx, config).start({
        spaceId: candidate.space_id,
        userId: row.user_id
      }, candidate.task_key, {
        version_id: v.id,
        config_hash: v.config_hash,
        kind: 'check',
        idempotency_key: `daily:${localMonitoringDate(cfg.timezone, new Date(row.next_run_at))}`
      }, new Date(row.next_run_at).toISOString());
      await tx.query(`UPDATE scheduler_tasks SET next_run_at=$2,last_run_at=$3,metadata_json=(metadata_json-'retry_after')||'{"blocked_reason":null}'::jsonb,updated_at=now() WHERE id=$1`, [candidate.id, computeNextRunAt(monitoringCron(cfg), now).toISOString(), row.next_run_at]);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // Keep the original slot so retry/restart cannot create a second daily operation.
      await tx.query(`UPDATE scheduler_tasks SET metadata_json=metadata_json||jsonb_build_object('blocked_reason',$2::text,'retry_after',$3::text),updated_at=now() WHERE id=$1`, [candidate.id, error.statusCode === 403 ? 'permission_changed' : 'monitoring_blocked', new Date(now.getTime()+60000).toISOString()]);
    }
  }).catch(async (error: unknown) => {
    failures.push(error);
    // The failed transaction rolled back. Back off separately, retaining the original
    // scheduled slot/day identity, so broken Projects cannot monopolize the first 25.
    await db.query(`UPDATE scheduler_tasks SET metadata_json=metadata_json||jsonb_build_object('blocked_reason','monitoring_error','retry_after',$2::text),updated_at=now() WHERE id=$1 AND next_run_at<=$3`,[candidate.id,new Date(now.getTime()+60000).toISOString(),now.toISOString()]).catch(error=>failures.push(error));
  });
  throwIfAnyFailed(failures, "Project monitoring scheduling");
  return due.length;
}
