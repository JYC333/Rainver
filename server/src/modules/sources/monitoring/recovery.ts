import type { Queryable } from '../../routeUtils/common.js';
/** Called only under the monitoring coordinator session lock after its Job and child Runs stopped. */
export async function recoverInterruptedMonitoringWork(db: Queryable, spaceId: string, operationId: string) {
  await db.query(`UPDATE source_backfill_segments segment SET status='pending',extraction_job_id=NULL,next_eligible_at=NULL,attempt_count=GREATEST(segment.attempt_count-1,0)
    FROM extraction_jobs job WHERE segment.space_id=$1 AND job.space_id=segment.space_id AND segment.extraction_job_id=job.id AND segment.status='running' AND job.metadata_json->>'monitoring_operation_id'=$2`, [spaceId, operationId]);
  await db.query(`UPDATE extraction_jobs SET status='failed',error_code='monitoring_interrupted',error_message='Coordinator stopped; cursor retained for explicit retry',completed_at=now() WHERE space_id=$1 AND metadata_json->>'monitoring_operation_id'=$2 AND status IN ('pending','running')`, [spaceId, operationId]);
}
