import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgFrontendSupportService } from "../src/modules/frontendSupport/service.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";

/**
 * Home's `job_queue_status.retryable` against real Job transitions: only a Job
 * that spent an attempt and is pending its next one, due now, counts — not an
 * exhausted failure, a source dispatch reclaim (never repeated), a first
 * pending Job or a deferral still in the future.
 */
const db = useTestDatabase(import.meta.filename);
const SPACE = "space-job-queue";
const USER = "user-job-queue";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["job_events", "jobs", "space_memberships", "users", "spaces"], { cascade: true });
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'S','team',now(),now())`, [SPACE]);
  await db.pool.query(
    `INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source)
     VALUES ($1,'u','active',now(),now(),lower(gen_random_uuid()::text || '@test.invalid'),'system')`, [USER]);
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
     VALUES (gen_random_uuid()::text,$1,$2,'owner','active',now(),now())`, [SPACE, USER]);
});

const queue = () => new PgJobQueueRepository(db.pool);
const status = async () => (await new PgFrontendSupportService(db.pool).homeSummary({ spaceId: SPACE, userId: USER }, {})).job_queue_status;

/** Enqueues one Job and runs it to `running` under `worker`. */
async function running(worker: string, maxAttempts: number) {
  // Its own type, so the claim takes this Job and not one pending from before.
  const type = `job_queue_status_${worker}`;
  const job = await queue().enqueue({ job_type: type, payload: {}, space_id: SPACE, user_id: USER, max_attempts: maxAttempts });
  const claimed = await queue().claimNext(worker, [type]);
  expect(claimed?.id).toBe(job.id);
  expect(await queue().startJob(job.id, worker)).toBe(true);
  return job.id;
}

describe("home job queue retryable count (real Postgres Job transitions)", () => {
  it("counts a failed attempt pending its retry, and nothing else", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A first pending Job has spent no attempt.
    await queue().enqueue({ job_type: "untouched", payload: {}, space_id: SPACE, user_id: USER, max_attempts: 3 });
    expect(await status()).toMatchObject({ queued: 1, retryable: 0 });

    // failJob with attempts left: pending for the next attempt — retryable.
    const retrying = await running("w1", 3);
    expect(await queue().failJob(retrying, "transient", "w1")).toBe("pending");
    expect(await status()).toMatchObject({ queued: 2, failed: 0, retryable: 1 });

    // failJob on the last attempt: failed, nothing will retry it.
    const exhausted = await running("w2", 1);
    expect(await queue().failJob(exhausted, "fatal", "w2")).toBe("failed");
    expect(await status()).toMatchObject({ failed: 1, retryable: 1 });

    // A stuck Job reclaimed with attempts left goes back to pending — retryable.
    const stuck = await running("w3", 3);
    // A stuck source dispatch whose external work started is failed, never repeated.
    const dispatched = await running("w4", 3);
    await db.pool.query(`UPDATE jobs SET result_json = '{"source_dispatch":"started"}'::jsonb WHERE id = $1`, [dispatched]);
    await db.pool.query(`UPDATE jobs SET heartbeat_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' WHERE id = ANY($1)`, [[stuck, dispatched]]);
    await queue().reclaimStuckJobs(60);
    const rows = await db.pool.query<{ id: string; status: string; attempts: number; max_attempts: number }>(
      "SELECT id, status, attempts, max_attempts FROM jobs WHERE id = ANY($1)", [[stuck, dispatched]]);
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))).toEqual({ [stuck]: "pending", [dispatched]: "failed" });
    // The dispatched one failed with attempts < max_attempts: the old count called it retryable.
    expect(rows.rows.find((row) => row.id === dispatched)!.attempts).toBeLessThan(3);
    expect(await status()).toMatchObject({ failed: 2, retryable: 2 });

    // A retry deferred into the future is waiting, not due now.
    await db.pool.query("UPDATE jobs SET scheduled_at = now() + interval '1 hour' WHERE id = $1", [stuck]);
    expect(await status()).toMatchObject({ retryable: 1 });
  });
});
