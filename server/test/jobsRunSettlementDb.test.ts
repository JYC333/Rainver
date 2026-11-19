import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRun, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { jobsModule } from "../src/modules/jobs/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";

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
  await resetTables(db.pool, ["jobs", "run_attempts", "runs", "agent_runtime_profiles", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"], { cascade: true });
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

  it("ends the queued Run when its provider_task_run job fails its final attempt, not before", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    const runId = await queueProviderTaskRun();
    const job = await jobs.enqueue({
      job_type: "provider_task_run",
      space_id: SPACE,
      user_id: OWNER,
      payload: { run_id: runId },
      max_attempts: 2,
    });
    const claimAttempt = (attempts: number) => db.pool!.query(
      `UPDATE jobs SET status = 'running', attempts = $2, claimed_by = 'worker-a' WHERE id = $1`,
      [job.id, attempts],
    );

    await claimAttempt(1);
    await expect(jobs.failJob(job.id, "precondition failed", "worker-a")).resolves.toBe("pending");
    expect(await runStatus(runId)).toEqual({ status: "queued", error_code: null });

    await claimAttempt(2);
    // Another worker's stale claim neither fails the job nor ends its Run.
    await expect(jobs.failJob(job.id, "precondition failed", "worker-b")).resolves.toBeNull();
    expect(await runStatus(runId)).toEqual({ status: "queued", error_code: null });

    await expect(jobs.failJob(job.id, "precondition failed", "worker-a")).resolves.toBe("failed");
    expect(await runStatus(runId)).toEqual({ status: "failed", error_code: "run_abandoned" });
  });

  it("keeps a reserved stop claim when a launched agent_run job fails its final attempt", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    const runId = randomUUID();
    await seedRun(db.pool, { id: runId, space: SPACE, owner: OWNER, agent: randomUUID(), version: randomUUID() });
    await db.pool.query(`UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`, [runId]);
    await db.pool.query(
      `INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, launch_id, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 'running', $4, now(), now())`,
      [randomUUID(), SPACE, runId, randomUUID()],
    );
    const job = await jobs.enqueue({
      job_type: "agent_run", space_id: SPACE, user_id: OWNER, payload: { run_id: runId }, max_attempts: 2,
    });
    await db.pool.query(
      `UPDATE jobs SET status = 'running', attempts = 2, claimed_by = 'worker-a' WHERE id = $1`,
      [job.id],
    );

    // The Host has not confirmed exit: the Run is not ended here and the job
    // stays claimable for stop reconciliation, without a new attempt budget.
    await expect(jobs.failJob(job.id, "controller lost", "worker-a")).resolves.toBe("pending");
    expect(await runStatus(runId)).toEqual({ status: "running", error_code: null });
    expect((await db.pool.query(
      `SELECT status, attempts, max_attempts, claimed_by, error FROM jobs WHERE id = $1`, [job.id],
    )).rows[0]).toEqual({ status: "pending", attempts: 1, max_attempts: 2, claimed_by: null, error: "controller lost" });
    const reclaimed = await jobs.claimNextAgentRun("worker-b");
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);
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

describe("jobs routes (real Postgres)", () => {
  afterEach(() => {
    __setAuthIdentityForTests(null);
    vi.restoreAllMocks();
  });

  function app() {
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER } as never);
    return buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test" }), [jobsModule]);
  }

  it("counts the jobs the list filters by job_type, so the total and the items agree", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    for (const job_type of ["extract_text", "agent_run", "agent_run"]) {
      await jobs.enqueue({ job_type, space_id: SPACE, user_id: OWNER, payload: {} });
    }
    const server = app();
    try {
      const response = await server.inject({ method: "GET", url: "/api/v1/jobs?job_type=extract_text&limit=50" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ total: 1 });
      expect(response.json().items).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("cancels only the person's own pending Job through the core and leaves a started Job to its worker", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    const pending = await jobs.enqueue({ job_type: "extract_text", space_id: SPACE, user_id: OWNER, payload: {} });
    const started = await jobs.enqueue({ job_type: "extract_text", space_id: SPACE, user_id: OWNER, payload: {} });
    await db.pool.query(`UPDATE jobs SET status = 'running', claimed_by = 'worker-1', claimed_at = now() WHERE id = $1`, [started.id]);
    const server = app();
    const cancel = (id: string, key?: string) => server.inject({ method: "POST", url: `/api/v1/jobs/${id}/cancel`, headers: key ? { "idempotency-key": key } : {} });
    const events = async (id: string) => (await db.pool!.query<{ n: string }>(`SELECT count(*)::text AS n FROM job_events WHERE job_id = $1 AND message = 'Job cancelled by user'`, [id])).rows[0]!.n;
    try {
      expect((await cancel(pending.id)).json().error.code).toBe("idempotency_key_required");
      const key = randomUUID(), first = await cancel(pending.id, key);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ status: "succeeded", data: { job_id: pending.id, status: "cancelled" } });
      const replay = await cancel(pending.id, key);
      expect(replay.json()).toEqual(first.json());
      expect(await events(pending.id)).toBe("1");
      // A new key on a terminal Job is a deterministic conflict, not a second cancellation.
      expect((await cancel(pending.id, randomUUID())).statusCode).toBe(409);
      const running = await cancel(started.id, randomUUID());
      expect(running.statusCode, running.body).toBe(409);
      expect(running.json().error.code).toBe("operation_conflict");
      await expect(db.pool.query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [started.id]))
        .resolves.toMatchObject({ rows: [{ status: "running" }] });
      expect(await events(started.id)).toBe("0");
    } finally {
      await server.close();
    }
  });

});
