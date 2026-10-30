import type { ServerConfig } from "../../config.js";
import type { Queryable, RunRecord } from "./repository.js";
import type { RunSettlementPort } from "./finalizationService.js";
import { PlanExecutionService } from "../plans/executionService.js";
import { WorkflowExecutionService } from "../automations/workflowExecutionService.js";
import { hostThreadDispatchInputs } from "../hosts/threadDispatchInputs.js";
import { recordHostThreadOutcome } from "../hosts/threadOutcome.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import { isHardTerminalRunStatus } from "./orchestrationResults.js";
import { runFinalizationReconcilerRegistry } from "./finalizationReconcilerRegistry.js";

/** Durable completion steps, shared by every terminal entrypoint and replay. */
export function runSettlement(config: ServerConfig, db: Queryable): RunSettlementPort {
  return {
    reconcilers: run => [
      ...(isHardTerminalRunStatus(run.status) ? [{
        key: "host_thread",
        // Done only when the Run no longer holds its thread: a refused outcome
        // (a newer turn reported) is fine, a claim still held is not.
        settle: async (run: RunRecord) => {
          const thread = hostThreadDispatchInputs(run);
          if (!thread.thread_id) return;
          const settled = await recordHostThreadOutcome(config, thread.thread_id, run,
            thread.resume_attempted, thread.identity, thread.standing);
          if (settled.claim === "run_not_terminal") throw new HostThreadClaimHeldError(run.id);
        },
        // A ledger may say done while the claim is still held (written before
        // the claim was its own obligation): the step is owed again.
        owed: async (run: RunRecord) => {
          const thread = hostThreadDispatchInputs(run);
          return Boolean(thread.thread_id) && new PgHostThreadRepository(db).holdsDispatchClaim(thread.thread_id!, run.id);
        },
      }] : []),
      {
        key: "plan_graph",
        settle: (run: RunRecord) => new PlanExecutionService(db, config)
          .reconcileForRun(run.space_id, run.id, run.owner_user_id ?? run.instructed_by_user_id ?? undefined),
      },
      { key: "workflow_graph", settle: (run: RunRecord) => new WorkflowExecutionService(config).reconcileForRun(db, run.space_id, run.id) },
      ...runFinalizationReconcilerRegistry.entries().map(({ key, reconcile }) => ({
        key,
        settle: (run: RunRecord) => reconcile(db, run),
      })),
    ],
  };
}

/** The Run's thread claim is still held and it is not ended: settlement stays owed. */
export class HostThreadClaimHeldError extends Error {
  readonly code = "host_thread_claim_held";
  constructor(runId: string) {
    super(`Run ${runId} still holds its host thread and is not terminal`);
    this.name = "HostThreadClaimHeldError";
  }
}
