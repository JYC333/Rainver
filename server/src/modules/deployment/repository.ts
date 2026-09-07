import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../../db/pool.js";
import type {
  DeploymentJob,
  DeploymentJobEvent,
  DeploymentJobType,
  DeploymentObservations,
  DeploymentStage,
  DeploymentStageStatus,
} from "@rainver/protocol";

/** Postgres unique-violation; the single-active index raises it on a race. */
const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

const JOB_COLUMNS = `
  id, job_type, status, requested_by_user_id,
  requested_at, started_at, ended_at,
  current_stage, failure_stage, error_text, target_tag,
  drain_timeout_seconds, result_json, last_progress_at`;

/**
 * `pg` returns `timestamptz` as a Date; the wire contract is an ISO string.
 * Normalizing here keeps every consumer — routes, the UI, tests — on one shape.
 */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

interface JobRow {
  id: string;
  job_type: DeploymentJobType;
  status: DeploymentJob["status"];
  requested_by_user_id: string;
  requested_at: unknown;
  started_at: unknown;
  ended_at: unknown;
  current_stage: DeploymentStage | null;
  failure_stage: DeploymentStage | null;
  error_text: string | null;
  target_tag: string | null;
  drain_timeout_seconds: number;
  result_json: unknown;
  last_progress_at: unknown;
}

function toJob(row: JobRow): DeploymentJob {
  return {
    ...row,
    requested_at: iso(row.requested_at),
    started_at: isoOrNull(row.started_at),
    ended_at: isoOrNull(row.ended_at),
    last_progress_at: isoOrNull(row.last_progress_at),
    result_json: (row.result_json && typeof row.result_json === "object" && !Array.isArray(row.result_json)
      ? row.result_json
      : {}) as Record<string, unknown>,
  };
}

/**
 * What the job says went wrong. The last line the stage printed is the part a
 * person acts on; the stage name alone only restates `failure_stage`.
 */
function failureReason(stage: string, logTail: string | null | undefined): string {
  const lastLine = (logTail ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return lastLine ? lastLine.slice(0, 500) : `${stage} failed`;
}

type EventRow = Omit<DeploymentJobEvent, "at"> & { at: unknown };

function toEvent(row: EventRow): DeploymentJobEvent {
  return { ...row, at: iso(row.at) };
}

export interface AppendEventInput {
  job_id: string;
  event_id: string;
  stage: DeploymentStage;
  status: DeploymentStageStatus;
  log_tail?: string | null;
  target_tag?: string | null;
  result_json?: Record<string, unknown>;
  terminal?: boolean;
}

/**
 * The stage a lost deployer was inside, or NULL when it had finished the one
 * it last reported.
 *
 * A job failed by the sweep or by a heartbeat has no failing stage of its own,
 * so the honest answer comes from the event stream: the last event names a
 * stage that was interrupted only when that event is its `started`. Taking
 * `current_stage` instead would mark a stage that succeeded as the one that
 * failed — the panel would say "Failed at Pull images" over an event stream
 * that shows the pull succeeding.
 */
const INTERRUPTED_STAGE = `(
  SELECT CASE WHEN e.status = 'started' THEN e.stage END
    FROM deployment_job_events e
   WHERE e.job_id = deployment_jobs.id
   ORDER BY e.seq DESC
   LIMIT 1
)`;

/**
 * Deployment job storage. Every state transition is a conditional UPDATE whose
 * zero-row result means the other side won — the deployer and an administrator
 * act on the same row from different processes, so a read-then-write would
 * hand out a job that was just cancelled.
 */
export class DeploymentRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  async createJob(input: {
    job_type: DeploymentJobType;
    requested_by_user_id: string;
    drain_timeout_seconds: number;
    now?: string;
  }): Promise<DeploymentJob> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<JobRow>(
      `INSERT INTO deployment_jobs
         (id, job_type, status, requested_by_user_id, requested_at,
          drain_timeout_seconds, result_json, active_lock)
       VALUES ($1, $2, 'queued', $3, $4, $5, '{}'::jsonb, 'active')
       RETURNING ${JOB_COLUMNS}`,
      [randomUUID(), input.job_type, input.requested_by_user_id, now, input.drain_timeout_seconds],
    );
    return toJob(result.rows[0]!);
  }

  /** Only a job the deployer has not picked up can be cancelled. */
  async cancelQueuedJob(jobId: string, now = new Date().toISOString()): Promise<DeploymentJob | null> {
    const result = await this.db.query<JobRow>(
      `UPDATE deployment_jobs
          SET status = 'cancelled', ended_at = $2, active_lock = NULL
        WHERE id = $1 AND status = 'queued'
        RETURNING ${JOB_COLUMNS}`,
      [jobId, now],
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async getJob(jobId: string): Promise<DeploymentJob | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM deployment_jobs WHERE id = $1`,
      [jobId],
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async listJobs(limit: number): Promise<DeploymentJob[]> {
    const result = await this.db.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM deployment_jobs ORDER BY requested_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toJob);
  }

  async activeJob(): Promise<DeploymentJob | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM deployment_jobs WHERE active_lock IS NOT NULL LIMIT 1`,
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async lastTerminalJob(): Promise<DeploymentJob | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM deployment_jobs
        WHERE active_lock IS NULL
        ORDER BY COALESCE(ended_at, requested_at) DESC, id DESC
        LIMIT 1`,
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  /**
   * Fail a `running` job on a heartbeat.
   *
   * The deployer's loop does not beat while it executes, so a heartbeat that
   * arrives with a job still `running` and claimed by *this same deployer*
   * means the process that claimed it died and came back. Waiting out the
   * lost-deployer threshold instead would leave every unattended Run deferred
   * for the rest of the hour.
   *
   * Scoped by `claimed_by` on purpose: a second deployer — a container being
   * replaced, or the host-run process the README documents — must not fail a
   * job another one is still executing, whose Compose commands would go on
   * running after the job was marked failed. An unrecognised holder is left to
   * the sweep.
   */
  async releaseAbandonedRunningJob(deployerId: string, now = new Date().toISOString()): Promise<number> {
    const result = await this.db.query(
      `UPDATE deployment_jobs
          SET status = 'failed',
              ended_at = $1,
              active_lock = NULL,
              failure_stage = COALESCE(failure_stage, ${INTERRUPTED_STAGE}),
              error_text = 'deployer_lost'
        WHERE status = 'running' AND claimed_by = $2`,
      [now, deployerId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Hand the deployer the queued job, exactly once. `FOR UPDATE SKIP LOCKED`
   * keeps two heartbeats from claiming the same row; the single-active index
   * means a running job leaves nothing to claim.
   */
  async claimQueuedJob(deployerId: string, now = new Date().toISOString()): Promise<DeploymentJob | null> {
    const result = await this.db.query<JobRow>(
      `UPDATE deployment_jobs
          SET status = 'running', started_at = $1, last_progress_at = $1, claimed_by = $2
        WHERE id = (
          SELECT id FROM deployment_jobs
           WHERE status = 'queued'
           ORDER BY requested_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING ${JOB_COLUMNS}`,
      [now, deployerId],
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  /**
   * Append one stage event and move the job with it. Returns null when the job
   * is not running any more — a cancelled or swept job must not be revived by
   * a late event.
   */
  async appendEvent(input: AppendEventInput, now = new Date().toISOString()): Promise<
    { job: DeploymentJob; event: DeploymentJobEvent } | null
  > {
    // A report whose response was lost is retried with the same id. Recording
    // it twice would put a duplicate in an append-only audit, and a retried
    // terminal event would be refused because its own first attempt had
    // already ended the job.
    const seen = await this.db.query<EventRow>(
      `SELECT seq, event_id, stage, status, at, log_tail
         FROM deployment_job_events WHERE job_id = $1 AND event_id = $2`,
      [input.job_id, input.event_id],
    );
    if (seen.rows[0]) {
      const job = await this.getJob(input.job_id);
      return job ? { job, event: toEvent(seen.rows[0]) } : null;
    }

    const failed = input.status === "failed";
    const terminal = failed || input.terminal === true;
    const jobResult = await this.db.query<JobRow>(
      `UPDATE deployment_jobs
          SET current_stage = $2,
              last_progress_at = $3,
              target_tag = COALESCE($4, target_tag),
              result_json = result_json || $5::jsonb,
              status = CASE WHEN $6 THEN (CASE WHEN $7 THEN 'failed' ELSE 'succeeded' END) ELSE status END,
              ended_at = CASE WHEN $6 THEN $3 ELSE ended_at END,
              active_lock = CASE WHEN $6 THEN NULL ELSE active_lock END,
              failure_stage = CASE WHEN $7 THEN $2 ELSE failure_stage END,
              error_text = CASE WHEN $7 THEN $8 ELSE error_text END
        WHERE id = $1 AND status = 'running'
        RETURNING ${JOB_COLUMNS}`,
      [
        input.job_id,
        input.stage,
        now,
        input.target_tag ?? null,
        JSON.stringify(input.result_json ?? {}),
        terminal,
        failed,
        failed ? failureReason(input.stage, input.log_tail) : null,
      ],
    );
    const job = jobResult.rows[0];
    if (!job) return null;

    const event = await this.db.query<EventRow>(
      `INSERT INTO deployment_job_events (id, job_id, event_id, seq, stage, status, at, log_tail)
       VALUES (
         $1::varchar, $2::varchar, $3::varchar,
         (SELECT COALESCE(MAX(seq), -1) + 1 FROM deployment_job_events WHERE job_id = $2::varchar),
         $4::varchar, $5::varchar, $6::timestamptz, $7::text
       )
       RETURNING seq, event_id, stage, status, at, log_tail`,
      [randomUUID(), input.job_id, input.event_id, input.stage, input.status, now, input.log_tail ?? null],
    );
    return { job: toJob(job), event: toEvent(event.rows[0]!) };
  }

  async listEvents(jobId: string): Promise<DeploymentJobEvent[]> {
    const result = await this.db.query<EventRow>(
      `SELECT seq, event_id, stage, status, at, log_tail FROM deployment_job_events
        WHERE job_id = $1 ORDER BY seq`,
      [jobId],
    );
    return result.rows.map(toEvent);
  }

  /**
   * A job the deployer stopped reporting on, or never picked up, is failed.
   *
   * Both halves matter because a non-terminal job defers every unattended Run:
   * without a bound, a stopped deployer would silently pause all scheduled
   * work forever, and no later update could be created either.
   */
  async failStaleJobs(
    cutoff: { running_before: string; queued_before: string },
    now = new Date().toISOString(),
  ): Promise<number> {
    const result = await this.db.query(
      `UPDATE deployment_jobs
          SET status = 'failed',
              ended_at = $3,
              active_lock = NULL,
              failure_stage = COALESCE(failure_stage, ${INTERRUPTED_STAGE}),
              error_text = CASE WHEN status = 'queued' THEN 'deployer_unavailable' ELSE 'deployer_lost' END
        WHERE (status = 'running' AND COALESCE(last_progress_at, started_at, requested_at) < $1)
           OR (status = 'queued' AND requested_at < $2)`,
      [cutoff.running_before, cutoff.queued_before, now],
    );
    return result.rowCount ?? 0;
  }

  async upsertObservations(input: {
    services: unknown[];
    remote: unknown | null;
    docker_version: string | null;
    observed_at: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO deployment_observations (id, services_json, remote_json, docker_version, observed_at)
       VALUES ('instance', $1::jsonb, $2::jsonb, $3, $4)
       ON CONFLICT (id) DO UPDATE
          SET services_json = EXCLUDED.services_json,
              remote_json = COALESCE(EXCLUDED.remote_json, deployment_observations.remote_json),
              docker_version = EXCLUDED.docker_version,
              observed_at = EXCLUDED.observed_at`,
      [
        JSON.stringify(input.services),
        input.remote === null ? null : JSON.stringify(input.remote),
        input.docker_version,
        input.observed_at,
      ],
    );
  }

  async getObservations(): Promise<DeploymentObservations | null> {
    const result = await this.db.query<{
      services_json: unknown;
      remote_json: unknown;
      docker_version: string | null;
      observed_at: unknown;
    }>(
      `SELECT services_json, remote_json, docker_version, observed_at
         FROM deployment_observations WHERE id = 'instance'`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      services: (Array.isArray(row.services_json) ? row.services_json : []) as DeploymentObservations["services"],
      remote: (row.remote_json ?? null) as DeploymentObservations["remote"],
      docker_version: row.docker_version,
      observed_at: iso(row.observed_at),
    };
  }

  async runningRunCount(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM runs WHERE status = 'running'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** True while an `update` job is waiting to start or already draining. */
  async updatePending(): Promise<boolean> {
    const result = await this.db.query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_jobs
          WHERE job_type = 'update' AND active_lock IS NOT NULL
       ) AS pending`,
    );
    return result.rows[0]?.pending === true;
  }
}
