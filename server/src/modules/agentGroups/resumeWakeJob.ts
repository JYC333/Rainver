import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { optionalString, type Queryable } from "../routeUtils/common.js";
import type { JobHandlerRegistry, JobHandlerResult } from "../jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { AgentGroupRunService } from "./service.js";

export const AGENT_GROUP_RESUME_WAKE_JOB = "agent_group_resume_wake";

/**
 * Resuming a group owes its parked Runs a re-evaluation: a dependency may have
 * finished while it was paused and woke nobody. The obligation commits with the
 * status change; one pending wake per group is enough, since it reads the group
 * as it is when it runs.
 */
export async function enqueueAgentGroupResumeWake(db: Queryable, input: { spaceId: string; userId: string; groupId: string }): Promise<void> {
  const existing = await db.query(
    `SELECT 1 FROM jobs WHERE space_id = $1 AND job_type = $2 AND payload_json->>'group_id' = $3 AND status = 'pending' LIMIT 1`,
    [input.spaceId, AGENT_GROUP_RESUME_WAKE_JOB, input.groupId],
  );
  if (existing.rows[0]) return;
  await new PgJobQueueRepository(db).enqueue({
    job_type: AGENT_GROUP_RESUME_WAKE_JOB, space_id: input.spaceId, user_id: input.userId, max_attempts: 5,
    payload: { group_id: input.groupId },
  });
}

/**
 * Wakes nothing unless the group is still active and the person who resumed it
 * still manages it: a later pause or cancel, or a withdrawn permission, ends the
 * obligation. Each parked Run is re-checked in its own transaction, so a repeat
 * after a crash queues nothing twice.
 */
export function registerAgentGroupResumeWakeHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  registry.register(AGENT_GROUP_RESUME_WAKE_JOB, async (job): Promise<JobHandlerResult> => {
    const groupId = optionalString(job.payload.group_id);
    if (!groupId || !job.user_id) throw new Error(`${AGENT_GROUP_RESUME_WAKE_JOB} requires group_id and user_id`);
    const service = new AgentGroupRunService(config, pool);
    const status = (await pool.query<{ status: string }>(
      "SELECT status FROM agent_run_groups WHERE space_id = $1 AND id = $2", [job.space_id, groupId])).rows[0]?.status;
    if (status !== "active") return { group_id: groupId, woken: false, reason: "not_active" };
    // Only a withdrawn permission ends the obligation; a failed read is the Job's to retry.
    if (!await service.managesGroup(pool, { spaceId: job.space_id, userId: job.user_id }, groupId)) {
      return { group_id: groupId, woken: false, reason: "not_managed" };
    }
    await service.reevaluateParkedRuns(job.space_id, groupId);
    return { group_id: groupId, woken: true };
  });
}
