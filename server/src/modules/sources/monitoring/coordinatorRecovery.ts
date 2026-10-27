import { throwIfAnyFailed } from '../../scheduler/registry.js';
import { reconcileMonitoringCoordinator } from '../../projects/monitoringControl.js';
import type { Queryable } from '../../routeUtils/common.js';
import { HttpError } from '../../routeUtils/common.js';
import type { ServerConfig } from '../../../config.js';
import { ProjectMonitoringService } from '../../projects/monitoring/service.js';

/** Reuse the same daily operation/allowance; Project lifecycle proves session and child safety. */
export async function recoverMonitoringCoordinators(db: Queryable, config: ServerConfig) {
  const stopped = await db.query<{
    space_id: string;
    project_id: string;
    created_by_user_id: string;
    version_id: string;
    config_hash: string;
    request_key: string;
    slot: string;
  }>(`SELECT o.space_id,o.project_id,o.created_by_user_id,v.id AS version_id,v.config_hash,o.progress_json->'idempotency'->>'key' AS request_key,o.progress_json->>'slot' AS slot FROM project_operations o JOIN project_information_monitoring_versions v ON v.id=o.progress_json->>'version_id' AND v.space_id=o.space_id JOIN scheduler_tasks task ON task.task_key=o.project_id AND task.space_id=o.space_id AND task.task_type='project_information_monitoring' AND task.status='active' WHERE o.status='active' AND o.progress_json->>'purpose'='information_monitoring' AND o.progress_json->>'run_kind'='daily' AND NOT EXISTS(SELECT 1 FROM jobs job WHERE job.space_id=o.space_id AND job.job_type='project_information_monitoring' AND job.payload_json->>'operation_id'=o.id AND job.status IN ('pending','claimed','running')) ORDER BY o.updated_at LIMIT 25`);
  const failures: unknown[] = [];
  for (const row of stopped.rows) {
    try {
      await reconcileMonitoringCoordinator(db, row.space_id, row.project_id);
      await new ProjectMonitoringService(db, config).start({
        spaceId: row.space_id,
        userId: row.created_by_user_id
      }, row.project_id, {
        version_id: row.version_id,
        config_hash: row.config_hash,
        kind: 'check',
        idempotency_key: row.request_key.replace(/^information_monitoring:/, '')
      }, row.slot);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        failures.push(error);
        continue;
      }
      await db.query(`UPDATE scheduler_tasks SET metadata_json=metadata_json||jsonb_build_object('blocked_reason',$3::text),updated_at=now() WHERE task_type='project_information_monitoring' AND task_key=$1 AND space_id=$2`, [row.project_id, row.space_id, error.statusCode === 403 ? 'permission_changed' : 'monitoring_blocked']).catch((updateError: unknown) => {
        failures.push(updateError);
      });
      // Admission was revoked; retain its durable pending work without dispatching or replacing a live Run.
    }
  }
  throwIfAnyFailed(failures, "Project monitoring coordinator recovery");
}
