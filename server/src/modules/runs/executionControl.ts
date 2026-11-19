import type { CliProcessRegistry } from "./localCliExecution.js";
import type { LaunchIsolationRecord, RunAttemptRecord, RunRecord } from "./repository.js";
import type { PgRunRepository } from "./repository.js";
import type { RuntimeStopOutcome } from "./runTimeLimit.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry } from "../hosts/connectionRegistry.js";

interface ExecutionControlRepository {
  getLatestRunAttempt?(spaceId: string, runId: string): Promise<RunAttemptRecord | null>;
}

export interface ExecutionStopResult extends RuntimeStopOutcome {
  attempt_number: number | null;
}

/** A parked/resumed Run still names its previous physical launch. Confirm that
 * launch has finished before replacing its nonce; a missing controller after
 * server restart is not evidence that its Host process exited. */
export async function bindHostAttemptLaunch(
  repository: Pick<PgRunRepository, 'getLatestRunAttempt' | 'bindAttemptLaunch'>,
  hosts: HostConnectionRegistry,
  input: { space_id: string; run_id: string; host_id: string; launch_id: string; isolation?: LaunchIsolationRecord },
): Promise<'bound' | 'closed' | 'previous_launch_unconfirmed'> {
  const previous = await repository.getLatestRunAttempt(input.space_id, input.run_id);
  if (!previous || !['queued', 'running'].includes(previous.status)) return 'closed';
  if (previous?.launch_id && previous.launch_id !== input.launch_id) {
    const stopped = await stopHostAttempt(hosts, input.host_id, input.run_id, previous.launch_id, false);
    if (!stopped.confirmed_exit) return 'previous_launch_unconfirmed';
  }
  return await repository.bindAttemptLaunch({ ...input, expected_launch_id: previous.launch_id, expected_attempt_id: previous.id }) ? 'bound' : 'closed';
}

export async function stopHostAttempt(hosts: HostConnectionRegistry, hostId: string, runId: string, launchId: string, force: boolean) {
  let confirmed_exit = await hosts.stopAttempt(hostId, runId, launchId, force ? 2_000 : 5_000, force);
  let force_kill_escalated = force;
  if (!confirmed_exit && !force) {
    force_kill_escalated = true;
    confirmed_exit = await hosts.stopAttempt(hostId, runId, launchId, 2_000, true);
  }
  return { confirmed_exit, force_kill_escalated };
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
        Object.assign(result, await stopHostAttempt(this.hosts, hostId, run.id, attempt.launch_id, force));
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
