import type { Queryable } from "../routeUtils/common.js";
import { contractWorkspaceAccess } from "../runs/contractSnapshot.js";
import { attentionResourceWait, attentionWorkspaceWait } from "../runs/attentionSummary.js";
import { isHardTerminalRunStatus } from "../runs/orchestrationResults.js";
import type { RunRecord } from "../runs/repository.js";

/** Read-only scheduling evidence for an already-authorized Run; never admits work. */
export async function readDelegationScheduling(db: Queryable, run: RunRecord) {
  const access = contractWorkspaceAccess(run.contract_snapshot_json);
  const output = run.output_json as Record<string, unknown> | null;
  const waiting = output?.waiting_for_results as { scope?: string } | undefined;
  let waitReason: string | null = attentionResourceWait({
    status: run.status,
    workspace: attentionWorkspaceWait(run.id),
    quota: Boolean(output?.waiting_for_quota),
    turn: Boolean(output?.waiting_for_turn),
    scope: waiting?.scope ?? null,
  });
  if (waitReason === "queued" && run.delegation_id && run.parent_run_id) {
    const row = (await db.query<{ status: string; parent_executing: boolean; admitted: boolean }>(
      `SELECT parent.status,
              EXISTS (SELECT 1 FROM run_execution_locks l WHERE l.run_id = parent.id) AS parent_executing,
              EXISTS (SELECT 1 FROM jobs j WHERE j.space_id = $1 AND j.job_type = 'agent_run'
                        AND j.payload_json->>'run_id' = $2
                        AND j.status IN ('pending', 'claimed', 'running')) AS admitted
         FROM runs parent WHERE parent.space_id = $1 AND parent.id = $3`,
      [run.space_id, run.id, run.parent_run_id],
    )).rows[0];
    if (row && !row.admitted) {
      waitReason = row.parent_executing || (!isHardTerminalRunStatus(row.status) && row.status !== "waiting_for_dependency")
        ? "waiting_for_parent"
        : "waiting_for_delegation_admission";
    }
  }
  return {
    workspace_access: access,
    workspace_concurrency: access === "read" ? "shared_read" as const : "exclusive_write" as const,
    wait_reason: waitReason,
  };
}
