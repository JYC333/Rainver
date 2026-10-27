import { expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { runJobWorkerPool } from "../src/modules/jobs/workerPool.js";
import { wakeJobWorkers } from "../src/modules/jobs/wakeSignal.js";

const db = useTestDatabase(import.meta.filename);
it("claims and completes independent jobs concurrently without duplicate ownership (real Postgres)", async ctx => {
  if (!db.available) return ctx.skip();
  const space = "fc000000-0000-4000-8000-000000000001";
  const owner = "fc000000-0000-4000-8000-000000000002";
  await seedSpaceOwnerProject(db.pool, { space, owner, project: "fc000000-0000-4000-8000-000000000003" });
  const queue = new PgJobQueueRepository(db.pool);
  const handlers = new JobHandlerRegistry();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const owners = new Set<string>();
  let firstEntered = false;
  let secondEntered = false;
  handlers.register("concurrency_probe", async job => {
    owners.add(job.worker_id);
    if (job.payload.session === "first") { firstEntered = true; await blocked; }
    else secondEntered = true;
    return {};
  });
  await queue.enqueue({ space_id: space, user_id: owner, job_type: "concurrency_probe", payload: { session: "first" } });
  await queue.enqueue({ space_id: space, user_id: owner, job_type: "concurrency_probe", payload: { session: "second" } });
  let stopped = false;
  const pool = runJobWorkerPool([0, 1].map(i => new JobWorker(queue, handlers, `pool-test:${i}`, ["concurrency_probe"])), {
    stopped: () => stopped, pollIntervalMs: 10, postWakeRecheckMs: 1, beforePoll: async () => {},
  });
  try {
    await vi.waitFor(() => { expect(firstEntered).toBe(true); expect(secondEntered).toBe(true); }, { timeout: 5000 });
    expect(owners.size).toBe(2);
  } finally {
    stopped = true;
    release();
    wakeJobWorkers();
    await pool;
  }
  const rows = await db.pool.query<{ status: string; attempts: number }>("SELECT status, attempts FROM jobs WHERE space_id = $1", [space]);
  expect(rows.rows).toHaveLength(2);
  expect(rows.rows.every(row => row.status === "completed" && row.attempts === 1)).toBe(true);
});
