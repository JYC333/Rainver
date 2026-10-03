import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import { withQueryableTransaction } from "../../routeUtils/common.js";
import { PgJobQueueRepository } from "../../jobs/repository.js";
import {
  PgSourcePostProcessingRepository,
  SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,
} from "./repository.js";

export async function enqueueDueSourcePostProcessingRules(
  config: ServerConfig,
  limit = 25,
): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const due = await new PgSourcePostProcessingRepository(db).listDueRules(new Date().toISOString(), limit);
  let enqueued = 0;
  for (const rule of due) {
    try {
      // One transaction: the job and the advance of `next_run_at` land
      // together, or neither does. Advancing after a committed enqueue left a
      // job behind when the advance failed, and the next tick enqueued the
      // same fire again.
      await withQueryableTransaction(db, async (client) => {
        await new PgJobQueueRepository(client).enqueue({
          job_type: SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,
          space_id: rule.space_id,
          user_id: rule.created_by_user_id,
          agent_id: rule.agent_id,
          payload: {
            trigger_type: "schedule",
            rule_id: rule.id,
            source_channel_id: rule.source_channel_id,
          },
        });
        await new PgSourcePostProcessingRepository(client).recordRuleFire(rule.space_id, rule.id);
      });
      enqueued += 1;
    } catch {
      // Leave scheduler state unchanged when the fire could not be recorded.
    }
  }
  return enqueued;
}
