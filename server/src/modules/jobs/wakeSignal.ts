/**
 * In-process wake signal for the jobs worker.
 *
 * The worker's idle branch used to sleep a fixed poll interval, so a job
 * enqueued right after a poll waited out most of that interval before it was
 * claimed. An enqueue now wakes the waiting loop directly.
 *
 * The poll interval stays as the fallback and is what keeps this correct
 * rather than merely fast — two cases never produce a signal this process can
 * hear:
 *
 *  - an enqueue from another process writing to the same database (a remote
 *    host daemon, a second server instance);
 *  - an enqueue inside a caller's transaction, which signals before its
 *    `COMMIT` makes the row visible to the worker's claim query.
 *
 * A missed or premature signal therefore costs latency, never a stuck job.
 *
 * There is no lost-wakeup window on the worker side: it registers its waiter
 * in the same synchronous continuation in which its claim query came back
 * idle, so no enqueue continuation can run in between.
 */

type Waiter = (outcome: JobWakeOutcome) => void;

export type JobWakeOutcome = "signalled" | "timeout";

const waiters = new Set<Waiter>();

/** Wake every waiting worker loop in this process. Cheap when none is waiting. */
export function wakeJobWorkers(): void {
  if (waiters.size === 0) return;
  for (const waiter of [...waiters]) waiter("signalled");
}

/**
 * Resolve as soon as `wakeJobWorkers` is called, or after `timeoutMs` — which
 * of the two is the return value, so a caller can tell a real wake from an
 * ordinary poll tick.
 */
export function waitForJobWake(timeoutMs: number): Promise<JobWakeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: JobWakeOutcome): void => {
      if (settled) return;
      settled = true;
      waiters.delete(waiter);
      clearTimeout(timer);
      resolve(outcome);
    };
    const waiter: Waiter = finish;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref?.();
    waiters.add(waiter);
  });
}
