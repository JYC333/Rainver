import { withQueryableTransaction } from '../../routeUtils/common.js';
import { lockActiveProjectForMutation } from '../access.js';
import type { JobStatus } from '../../jobs/repository.js';
import { tryWithDedicatedSessionAdvisoryLock } from '../../../db/advisoryLock.js';
import { recoverInterruptedMonitoringWork } from '../../sources/monitoring/recovery.js';
import type { Queryable } from '../../routeUtils/common.js';
const terminalJobs: ReadonlySet<JobStatus> = new Set<JobStatus>(['completed', 'failed', 'cancelled']);
/** Project lock is held by the caller. Never wait for or retire a live coordinator. */
export async function reconcileStoppedMonitoring(db: Queryable, spaceId: string, projectId: string): Promise<void> {
  await tryWithDedicatedSessionAdvisoryLock(db, `monitoring-run:${spaceId}:${projectId}`, async tx => {
    const operations = await tx.query<{
      id: string;
    }>(`SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2 AND status='active' AND progress_json->>'purpose'='information_monitoring' FOR UPDATE`, [spaceId, projectId]);
    for (const op of operations.rows) {
      const jobs = await tx.query<{
        status: JobStatus;
      }>(`SELECT status FROM jobs WHERE space_id=$1 AND job_type='project_information_monitoring' AND payload_json->>'operation_id'=$2 FOR UPDATE`, [spaceId, op.id]);
      if (jobs.rows.some(j => !terminalJobs.has(j.status))) continue;
      const children = await tx.query(`SELECT id FROM runs WHERE space_id=$1 AND contract_snapshot_json->'source'->>'id'=$2 AND status NOT IN ('succeeded','degraded','failed','cancelled','orphaned') LIMIT 1`, [spaceId, op.id]);
      if (children.rows.length) continue;
      await recoverInterruptedMonitoringWork(tx, spaceId, op.id);
      await tx.query(`UPDATE project_operations SET status='completed',progress_json=progress_json||jsonb_build_object('phase','partial','reason','processing_failed','recovery_required',true,'as_of',now()),updated_at=now() WHERE id=$1 AND space_id=$2 AND status='active'`, [op.id, spaceId]);
    }
  });
}
export async function stoppedMonitoringJob(db: Queryable, spaceId: string, operationId: string): Promise<boolean> {
  const jobs = await db.query<{
    status: JobStatus;
  }>(`SELECT status FROM jobs WHERE space_id=$1 AND job_type='project_information_monitoring' AND payload_json->>'operation_id'=$2`, [spaceId, operationId]);
  return !jobs.rows.some(j => !terminalJobs.has(j.status));
}

/** Internal Sources recovery port: close dead work even when its former owner lost dispatch authority. */
export async function reconcileMonitoringCoordinator(db: Queryable, spaceId: string, projectId: string) {
  await withQueryableTransaction(db, async tx => {
    await lockActiveProjectForMutation(tx, spaceId, projectId);
    await reconcileStoppedMonitoring(tx, spaceId, projectId);
  });
}
