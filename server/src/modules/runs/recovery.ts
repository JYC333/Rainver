import type { ServerConfig } from "../../config.js";
import { PgRunRepository } from "./repository.js";
import { RunMaterializationService } from "./materializationService.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { finalizeChatTurn, recordChatTurnFinalizationFailure, type ChatTurnFinalizerDeps } from "./chatTurnFinalizer.js";
import { isHardTerminalRunStatus } from "./orchestrationResults.js";
import { finalizedForPostRun } from "./finalizationOutcome.js";

interface RecoveryLogger { warn(message: string): void }

/** Replays durable lifecycle obligations; never executes an Agent directly. */
export class RunRecoveryService {
  constructor(private readonly config: ServerConfig, private readonly runs = PgRunRepository.fromConfig(config)) {}

  /**
   * One pass. Steps are independent obligations, so one failing (a query
   * error, one bad Run) never keeps the rest of the pass from theirs; each
   * failure is logged and retried next pass. A step that does not return is
   * not abandoned or overlapped: the loop reports the stall (`RunRecoveryLoop`).
   */
  async recover(log?: RecoveryLogger): Promise<void> {
    const jobs = PgJobQueueRepository.fromConfig(this.config);
    const materializer = RunMaterializationService.fromConfig(this.config);
    const steps: Array<[string, () => Promise<void>]> = [
      ["cancellation_intent", async () => {
        for (const run of await this.runs.listCancellingAgentRuns()) {
          const userId = run.instructed_by_user_id ?? run.owner_user_id;
          if (!userId) { log?.warn(`[runs] cancelled-intent Run ${run.id} has no job actor`); continue; }
          await isolated(log, `cancellation of Run ${run.id}`, () => jobs.ensureAgentRunJob({ job_type: "agent_run",
            space_id: run.space_id, user_id: userId, agent_id: run.agent_id, project_folder_id: run.project_folder_id,
            payload: { run_id: run.id } }));
        }
      }],
      ["stale_preparation", async () => {
        const recovered = await this.runs.recoverStaleRuns(3600);
        if (recovered) log?.warn(`[runs] recovered ${recovered} stale preparation(s)`);
      }],
      ["orphaned_finalization", async () => {
        for (const item of await this.runs.listOrphanedRunIds()) {
          await isolated(log, `orphaned Run ${item.id} finalization`, async () => {
            const run = await this.runs.getRun(item.space_id, item.id);
            if (run) await materializer.finalizeRun(run);
          });
        }
      }],
      ["chat_completion", () => reconcileTerminalChatRuns(this.config, this.runs, log, materializer)],
      ["task_finalization", () => reconcileUnfinalizedTaskRuns(this.config, this.runs, log, materializer)],
      ["settlement", () => resumeUnsettledRuns(this.config, this.runs, log, materializer)],
    ];
    for (const [name, step] of steps) await isolated(log, `recovery step ${name}`, step);
  }
}

async function isolated(log: RecoveryLogger | undefined, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log?.warn(`[runs] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function reconcileTerminalChatRuns(
  config: ServerConfig,
  runs: PgRunRepository,
  log?: RecoveryLogger,
  materializer: Pick<RunMaterializationService, "finalizeRun"> =
    RunMaterializationService.fromConfig(config),
  finalizerDeps: ChatTurnFinalizerDeps = {},
): Promise<void> {
  const pending = await runs.listTerminalChatRunsAwaitingCompletion();
  for (const item of pending) {
    try {
      const run = await runs.getRun(item.space_id, item.id);
      if (!run) continue;
      const finalization = await materializer.finalizeRun(run);
      if (finalization.error_code === "finalization_in_progress") continue;
      // Owed settlement is finished for the chat turn: the sweep settles the rest.
      if (!finalizedForPostRun(finalization)) {
        throw new Error(
          finalization.error_message ?? "Run finalization reconciliation failed.",
        );
      }
      const current = await runs.getRun(item.space_id, item.id);
      if (current && isHardTerminalRunStatus(current.status)) {
        try {
          await finalizeChatTurn(config, runs, current, finalizerDeps);
        } catch (error) {
          // Bounded: a successful chat Run holds its conversation until it
          // completes, so a finalization that keeps failing must not hold it
          // for good. Past the bound the turn completes as failed.
          const failure = await recordChatTurnFinalizationFailure(config, runs, current, error, finalizerDeps);
          if (!failure.completed) throw error;
          log?.warn(
            `[jobs-worker] chat Run ${item.id} completed as failed after ${failure.attempts} finalization attempts: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      log?.warn(
        `[jobs-worker] chat Run ${item.id} completion deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const waitingForReview = await runs.listWaitingRoomChatRunsAwaitingReply();
  for (const item of waitingForReview) {
    try {
      const run = await runs.getRun(item.space_id, item.id);
      if (!run || run.status !== "waiting_for_review") continue;
      await finalizeChatTurn(config, runs, run, finalizerDeps);
    } catch (error) {
      log?.warn(
        `[jobs-worker] waiting Room Run ${item.id} reply deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * A Task's terminal Run that nobody finalized — its job was cancelled or gave
 * up, recovery cancelled it, a module ended it by hand — is finalized here,
 * so its Task is settled (`projectWork/finalizationReconciler.ts`) whatever
 * path ended the Run. The paths that can, finalize at once and this finds
 * nothing.
 */
export async function reconcileUnfinalizedTaskRuns(
  config: ServerConfig,
  runs: PgRunRepository,
  log?: RecoveryLogger,
  materializer: Pick<RunMaterializationService, "finalizeRun"> =
    RunMaterializationService.fromConfig(config),
): Promise<void> {
  for (const item of await runs.listTaskRunsAwaitingFinalization()) {
    try {
      const run = await runs.getRun(item.space_id, item.id);
      if (!run) continue;
      const finalization = await materializer.finalizeRun(run);
      if (finalization.error_code === "finalization_in_progress") continue;
      if (!finalizedForPostRun(finalization)) {
        throw new Error(finalization.error_message ?? "Run finalization failed.");
      }
    } catch (error) {
      log?.warn(
        `[jobs-worker] Task Run ${item.id} finalization deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * A finalized Run whose settlement is still owed — a reconciler failed, or the
 * process died between the finalization record and the completion gate — is
 * settled here. Finalizing again resumes from the reconcilers not yet
 * completed; the Agent, its model calls and its output are never redone.
 */
export async function resumeUnsettledRuns(
  config: ServerConfig,
  runs: PgRunRepository,
  log?: RecoveryLogger,
  materializer: Pick<RunMaterializationService, "finalizeRun"> =
    RunMaterializationService.fromConfig(config),
): Promise<void> {
  for (const item of await runs.listUnsettledFinalizations()) {
    try {
      const run = await runs.getRun(item.space_id, item.run_id);
      if (!run) continue;
      const settled = await materializer.finalizeRun(run);
      if (settled.error_code === "finalization_in_progress") continue;
      if (settled.status !== "succeeded") log?.warn(`[runs] Run ${item.run_id} settlement still owed: ${settled.error_code ?? "unknown"}`);
    } catch (error) {
      log?.warn(`[runs] Run ${item.run_id} recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
