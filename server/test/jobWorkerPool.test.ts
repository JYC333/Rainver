import { expect, it, vi } from "vitest";
import { runJobWorkerPool } from "../src/modules/jobs/workerPool.js";
import { wakeJobWorkers } from "../src/modules/jobs/wakeSignal.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it("runs an independent job while another lane is blocked, then drains both on stop", async () => {
  const blocked = gate();
  const entered = gate();
  let stopped = false;
  const first = vi.fn(async () => {
    entered.release();
    await blocked.promise;
    return { status: "completed" as const, job_id: "first" };
  });
  const second = vi.fn(async () => {
    await entered.promise;
    stopped = true;
    return { status: "completed" as const, job_id: "second" };
  });
  let drained = false;
  const running = runJobWorkerPool([{ processOne: first }, { processOne: second }], {
    stopped: () => stopped, pollIntervalMs: 10, postWakeRecheckMs: 1, beforePoll: async () => {},
  }).then(() => { drained = true; });
  await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
  expect(drained).toBe(false);
  blocked.release();
  await running;
  expect(first).toHaveBeenCalledOnce();
});

it("wakes idle lanes for shutdown without taking new jobs", async () => {
  let stopped = false;
  const idle = vi.fn(async () => ({ status: "idle" as const }));
  const running = runJobWorkerPool([{ processOne: idle }, { processOne: idle }], {
    stopped: () => stopped, pollIntervalMs: 60_000, postWakeRecheckMs: 1, beforePoll: async () => {},
  });
  await vi.waitFor(() => expect(idle).toHaveBeenCalledTimes(2));
  stopped = true;
  wakeJobWorkers();
  await running;
  expect(idle).toHaveBeenCalledTimes(2);
});
