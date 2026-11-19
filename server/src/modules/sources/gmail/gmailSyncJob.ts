/**
 * The `gmail_mailbox_sync` Job: one sync of one connection
 * (`gmailMailboxSync.ts`). Its payload is the connection id only. The sync
 * records its own outcome, backoff and follow-up on the cursor row, so the
 * Job never retries by itself (`max_attempts: 1`); an unexpected crash leaves
 * a lease that expires and the heartbeat queues the next sync.
 */
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import type { JobHandlerRegistry } from "../../jobs/handlerRegistry.js";
import { syncGmailMailbox } from "./gmailMailboxSync.js";
import { GMAIL_SYNC_JOB } from "./gmailMonitors.js";
import { startDueGmailDigests } from "./gmailDigests.js";

export function registerGmailMailboxSyncJob(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  registry.register(GMAIL_SYNC_JOB, async (job) => {
    const connectionId = typeof job.payload.connection_id === "string" ? job.payload.connection_id : "";
    if (!/^[A-Za-z0-9-]{1,36}$/.test(connectionId)) return { status: "invalid" };
    const db = getDbPool(config.databaseUrl!);
    const outcome = await syncGmailMailbox(config, db, connectionId);
    if (outcome.status === "synced" && outcome.newMatches > 0) {
      await startDueGmailDigests(db, config, 20, connectionId);
    }
    // Ids, counts and fixed codes only: no header, subject or address reaches the Job result.
    return outcome.status === "synced" ? { status: outcome.status, new_matches: outcome.newMatches, more: outcome.more }
      : outcome.status === "failed" ? { status: outcome.status, code: outcome.code } : { status: outcome.status };
  });
}
