import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { RoomDiscussionService } from "../rooms/discussionService.js";
import { ExperimentRunService } from "../experiments/runService.js";
import { PgRunRepository } from "./repository.js";
import { RunMaterializationService } from "./materializationService.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { finalizeChatTurn, recordChatTurnFinalizationFailure, type ChatTurnFinalizerDeps } from "./chatTurnFinalizer.js";
import { isHardTerminalRunStatus } from "./orchestrationResults.js";
import { finalizedForPostRun } from "./finalizationOutcome.js";
import { nextRecoveryCursor, type RecoveryCursor } from "./recoveryCursor.js";

interface RecoveryLogger { warn(message: string): void }
interface RecoveryDependencies {
  discussions?: Pick<RoomDiscussionService, "recoverUnadvancedWaves">;
  experiments?: Pick<ExperimentRunService, "listRunsAwaitingFinalization">;
}

/** Replays durable lifecycle obligations; never executes an Agent directly. */
export class RunRecoveryService {
  private readonly discussions?: RecoveryDependencies["discussions"];
  private readonly experiments?: RecoveryDependencies["experiments"];
  private chatCursor: RecoveryCursor | null = null;
  private experimentCursor: RecoveryCursor | null = null;

  constructor(private readonly config: ServerConfig, private readonly runs = PgRunRepository.fromConfig(config), deps: RecoveryDependencies = {}) {
    const pool = config.databaseUrl ? getDbPool(config.databaseUrl) : null;
    this.discussions = deps.discussions ?? (pool ? new RoomDiscussionService(config, pool) : undefined);
    this.experiments = deps.experiments ?? (pool ? new ExperimentRunService(pool) : undefined);
  }

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
          await isolated(log, `cancellation of Run ${run.id}`, () => jobs.ensureRunCancellationJob(run.space_id, run.id));
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
      ["chat_completion", async () => {
        this.chatCursor = await reconcileTerminalChatRuns(this.config, this.runs, log, materializer, {}, this.chatCursor);
      }],
      ["room_discussion_advance", async () => {
        await this.discussions?.recoverUnadvancedWaves((groupId, error) => log?.warn(
          `[runs] Room wave ${groupId} recovery failed: ${error instanceof Error ? error.message : String(error)}`));
      }],
      ["task_finalization", () => reconcileUnfinalizedTaskRuns(this.config, this.runs, log, materializer)],
      ["experiment_finalization", async () => {
        if (!this.experiments) return;
        const limit = 100;
        const pending = await this.experiments.listRunsAwaitingFinalization(limit, this.experimentCursor);
        this.experimentCursor = nextRecoveryCursor(pending, limit);
        for (const item of pending) await isolated(log, `Experiment Run ${item.id} finalization`, async () => {
          const run = await this.runs.getRun(item.space_id, item.id);
          if (!run || !isHardTerminalRunStatus(run.status)) return;
          const finalization = await materializer.finalizeRun(run);
          if (finalization.error_code !== "finalization_in_progress" && !finalizedForPostRun(finalization)) {
            throw new Error(finalization.error_message ?? "Run finalization failed");
          }
        });
      }],
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
  after: RecoveryCursor | null = null,
): Promise<RecoveryCursor | null> {
  const limit = 100;
  const pending = await runs.listTerminalChatRunsAwaitingCompletion(limit, after);
  for (const item of pending) {
    try {
      const run = await runs.getRun(item.space_id, item.id);
      if (!run || !isHardTerminalRunStatus(run.status)) continue;
      try {
        const finalization = await materializer.finalizeRun(run);
        if (finalization.error_code === "finalization_in_progress") continue;
        // Owed settlement is finished for the chat turn: the sweep settles the rest.
        if (!finalizedForPostRun(finalization)) {
          throw new Error(finalization.error_message ?? "Run finalization reconciliation failed.");
        }
        const current = await runs.getRun(item.space_id, item.id);
        if (current && isHardTerminalRunStatus(current.status)) await finalizeChatTurn(config, runs, current, finalizerDeps);
      } catch (error) {
        // Both materialization and publication can hold the turn. Count either
        // failure in the same durable bound, while a newly queued retry can run.
        const current = await runs.getRun(item.space_id, item.id);
        if (!current || !isHardTerminalRunStatus(current.status)) continue;
        const failure = await recordChatTurnFinalizationFailure(config, runs, current, error, finalizerDeps);
        if (!failure.completed) throw error;
        log?.warn(`[jobs-worker] chat Run ${item.id} completed as failed after ${failure.attempts} finalization attempts: ${
          error instanceof Error ? error.message : String(error)}`);
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
  return nextRecoveryCursor(pending, limit);
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
