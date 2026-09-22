import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";

/**
 * What the job queue owes the Run behind a job it stops carrying.
 *
 * Both Run-backed job types leave a Run behind: `agent_run` and
 * `provider_task_run`. A queued ProviderTask Run has no execution lock, no
 * `started_at` and no adapter, so nothing else finishes it — `recoverStaleRuns`
 * reclaims only rows that actually started. If cancellation and reclamation do
 * not settle it here, it stays `queued` forever, still counted against its
 * domain's daily budget.
 */

const SPACE = "7a111111-1111-4111-8111-111111111111";
const OWNER = "7a222222-2222-4222-8222-222222222222";
const PROJECT = "7a333333-3333-4333-8333-333333333333";

const db = useTestDatabase(import.meta.filename, { max: 2 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["jobs", "runs", "projects", "space_memberships", "users", "spaces"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

async function queueProviderTaskRun(): Promise<string> {
  const run = await new PgRunRepository(db.pool).createQueuedProviderTaskRun({
    space_id: SPACE,
    user_id: OWNER,
    trigger_origin: "manual",
    run_type: "agent",
    task: "bounded_task",
    prompt: "Perform the bounded task.",
    project_id: PROJECT,
    capability_id: "test.bounded_task",
    contract_snapshot: { source: { kind: "direct", id: null } },
  });
  return run.id;
}

async function runStatus(runId: string): Promise<{ status: string; error_code: string | null }> {
  const result = await db.pool.query<{ status: string; error_json: { error_code?: string } | null }>(
    `SELECT status, error_json FROM runs WHERE id = $1`,
    [runId],
  );
  return {
    status: result.rows[0]?.status ?? "(missing)",
    error_code: result.rows[0]?.error_json?.error_code ?? null,
  };
}

describe("job settlement of the Run behind a job (real Postgres)", () => {
  it("cancels the queued ProviderTask Run of a cancelled provider_task_run job", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    const runId = await queueProviderTaskRun();
    const job = await jobs.enqueue({
      job_type: "provider_task_run",
      space_id: SPACE,
      user_id: OWNER,
      payload: { run_id: runId },
    });

    await expect(jobs.cancelJob(job.id, null)).resolves.toBe(true);

    expect(await runStatus(runId)).toEqual({ status: "cancelled", error_code: "run_cancelled" });
  });

  it("abandons the Run of a provider_task_run job that is stuck with no attempts left", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    const runId = await queueProviderTaskRun();
    const job = await jobs.enqueue({
      job_type: "provider_task_run",
      space_id: SPACE,
      user_id: OWNER,
      payload: { run_id: runId },
      max_attempts: 3,
    });
    // A worker that claimed the last attempt and then died: no heartbeat, no
    // retries left, and nothing else in the system knows about this Run.
    await db.pool.query(
      `UPDATE jobs
          SET status = 'running', attempts = max_attempts, claimed_by = 'dead-worker',
              claimed_at = now() - interval '2 hours',
              heartbeat_at = now() - interval '2 hours',
              updated_at = now() - interval '2 hours'
        WHERE id = $1`,
      [job.id],
    );

    const reclaimed = await jobs.reclaimStuckJobs(600);

    expect(reclaimed.reclaimed_count).toBe(1);
    expect(reclaimed.exhausted_jobs.map((entry) => entry.id)).toEqual([job.id]);
    expect(await runStatus(runId)).toEqual({ status: "failed", error_code: "run_abandoned" });
    // The Run never started, so it keeps the queued ProviderTask shape: no
    // ModelProvider and no ledger references, which `ck_runs_execution_shape`
    // requires of a terminal Run that was never dispatched.
    expect((await db.pool.query<{ started_at: string | null; model_provider_id: string | null }>(
      `SELECT started_at, model_provider_id FROM runs WHERE id = $1`, [runId],
    )).rows[0]).toEqual({ started_at: null, model_provider_id: null });
  });

  it("leaves a stuck provider_task_run job's Run alone while it still has attempts", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    const runId = await queueProviderTaskRun();
    const job = await jobs.enqueue({
      job_type: "provider_task_run",
      space_id: SPACE,
      user_id: OWNER,
      payload: { run_id: runId },
      max_attempts: 3,
    });
    await db.pool.query(
      `UPDATE jobs
          SET status = 'running', attempts = 1, claimed_by = 'slow-worker',
              claimed_at = now() - interval '2 hours',
              heartbeat_at = now() - interval '2 hours',
              updated_at = now() - interval '2 hours'
        WHERE id = $1`,
      [job.id],
    );

    await expect(jobs.reclaimStuckJobs(600)).resolves.toMatchObject({ reclaimed_count: 1 });

    expect((await db.pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1`, [job.id],
    )).rows[0]?.status).toBe("pending");
    expect(await runStatus(runId)).toEqual({ status: "queued", error_code: null });
  });
});
