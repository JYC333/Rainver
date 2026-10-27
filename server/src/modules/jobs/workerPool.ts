import type { JobWorker } from "./worker.js";
import { waitForJobWake } from "./wakeSignal.js";

/** Each lane owns a worker identity; one long Run never stalls unrelated jobs. */
export async function runJobWorkerPool(
  workers: readonly Pick<JobWorker, "processOne">[],
  options: {
    stopped: () => boolean;
    pollIntervalMs: number;
    postWakeRecheckMs: number;
    beforePoll: () => Promise<void>;
    log?: { warn: (message: string) => void; error: (message: string) => void };
  },
): Promise<void> {
  await Promise.all(workers.map(async worker => {
    let idleWaitMs = options.pollIntervalMs;
    while (!options.stopped()) {
      try {
        await options.beforePoll();
        if (options.stopped()) break;
        const result = await worker.processOne();
        if (result.status === "idle" && !options.stopped()) {
          const wake = await waitForJobWake(idleWaitMs);
          idleWaitMs = wake === "signalled" ? options.postWakeRecheckMs : options.pollIntervalMs;
        } else {
          idleWaitMs = options.pollIntervalMs;
          if (result.status === "failed") options.log?.warn(`[jobs-worker] job ${result.job_id} failed: ${result.error}`);
        }
      } catch (error) {
        options.log?.error(`[jobs-worker] loop error: ${error instanceof Error ? error.message : String(error)}`);
        if (!options.stopped()) await waitForJobWake(options.pollIntervalMs);
      }
    }
  }));
}
