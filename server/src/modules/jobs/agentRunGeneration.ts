/** Job-owned marker. A Run may dispatch again within the same physical attempt. */
export const SUPERSEDED_AGENT_RUN_JOB = "agent_run_dispatch_superseded";

/** Applied by queue readers that ask whether an Agent Run still has a dispatch. */
export function currentAgentRunJobSql(alias: "jobs" | "job" | "j" = "jobs"): string {
  return `NOT (${alias}.payload_json ? '${SUPERSEDED_AGENT_RUN_JOB}')`;
}

/** Sends a persisted stop request even while the execution Job still has a worker. */
export const RUN_CANCELLATION_RECONCILE_JOB = "run_cancellation_reconcile";
