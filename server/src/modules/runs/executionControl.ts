import type { CliProcessRegistry } from "./localCliExecution.js";
import type { RunAttemptRecord, RunRecord } from "./repository.js";
import type { RuntimeStopOutcome } from "./runTimeLimit.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry } from "../hosts/connectionRegistry.js";

interface ExecutionControlRepository {
  getLatestRunAttempt?(spaceId: string, runId: string): Promise<RunAttemptRecord | null>;
}

export interface ExecutionStopResult extends RuntimeStopOutcome {
  attempt_number: number | null;
}

/** One stop protocol for cancellation, explicit deadlines and lost-worker recovery. */
export class RunExecutionControl {
  constructor(
    private readonly repository: ExecutionControlRepository,
    private readonly resolveHostId: (run: RunRecord) => Promise<string>,
    private readonly processes?: CliProcessRegistry,
    private readonly hosts: HostConnectionRegistry = sharedHostConnectionRegistry,
  ) {}

  async stop(run: RunRecord, force = false): Promise<ExecutionStopResult> {
    const result: ExecutionStopResult = {
      attempt_number: null,
      process_terminated: false,
      confirmed_exit: false,
      force_kill_escalated: force,
    };
    // Abort an invocation that has not registered its process yet as well.
    // This prevents a stop during preparation from being followed by a launch.
    try {
      const registered = force && this.processes?.forceTerminate
        ? this.processes.forceTerminate(run.id)
        : this.processes?.terminate(run.id) ?? false;
      // Read after aborting preparation so a just-bound launch is visible.
      const attempt = await this.repository.getLatestRunAttempt?.(run.space_id, run.id);
      result.attempt_number = attempt?.attempt_number ?? null;
      if (attempt?.launch_id) {
        // Controller unwind (including disconnect) is not physical exit.
        // A persisted dispatch always requires the Host's exact nonce ack.
        const hostId = await this.resolveHostId(run);
        if (!hostId) return result;
        result.process_terminated = this.hosts.isOnline(hostId);
        result.confirmed_exit = await this.hosts.stopAttempt(hostId, run.id, attempt.launch_id, force ? 2_000 : 5_000, force);
        if (!result.confirmed_exit && !force) {
          result.force_kill_escalated = true;
          result.confirmed_exit = await this.hosts.stopAttempt(hostId, run.id, attempt.launch_id, 2_000, true);
        }
        return result;
      }
      if (registered) {
        result.process_terminated = true;
        result.confirmed_exit = this.processes?.waitForExit
          ? await this.processes.waitForExit(run.id, force ? 2_000 : 5_000)
          : true;
        if (!result.confirmed_exit) {
          result.force_kill_escalated = this.processes?.forceTerminate?.(run.id) ?? false;
          result.confirmed_exit = await this.processes?.waitForExit?.(run.id, 2_000) ?? false;
        }
        return result;
      }
      // Dispatch records its nonce before launch. With preparation aborted
      // and no recorded dispatch, there is no remote process to confirm.
      result.confirmed_exit = true;
      return result;
    } catch {
      // Failure to reach or confirm the process is not proof of exit.
      return result;
    }
  }
}
