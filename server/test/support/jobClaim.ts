import type { Pool } from "pg";
import { PgJobQueueRepository } from "../../src/modules/jobs/repository.js";
import type { JobEnvelopeForHandler } from "../../src/modules/jobs/handlerRegistry.js";

/**
 * Claims one specific pending Job and starts it the way a worker does, and
 * returns the envelope its handler runs with. `claimNext` picks by priority, so
 * the claim is its own statement narrowed to this id; the start is the queue's
 * real `startJob`. Handlers that fence on the current claim (status, worker,
 * attempt) see exactly the state a live worker holds.
 */
export async function claimJobForHandler(pool: Pool, jobId: string, workerId = "test"): Promise<JobEnvelopeForHandler> {
  const claimed = (await pool.query(
    `UPDATE jobs SET status='claimed', claimed_by=$2, claimed_at=now(), heartbeat_at=NULL, attempts=attempts+1, updated_at=now()
      WHERE id=$1 AND status='pending' AND attempts<max_attempts RETURNING *`,
    [jobId, workerId],
  )).rows[0];
  if (!claimed) throw new Error(`Job ${jobId} is not claimable`);
  if (!(await new PgJobQueueRepository(pool).startJob(jobId, workerId))) throw new Error(`Job ${jobId} start refused`);
  return {
    job_id: claimed.id, space_id: claimed.space_id, user_id: claimed.user_id, job_type: claimed.job_type,
    attempts: claimed.attempts, max_attempts: claimed.max_attempts, worker_id: workerId, payload: claimed.payload_json ?? {},
  };
}
