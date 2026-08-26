import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import { projectTaskStatusFromRun } from "../tasks/taskRunStatusProjection.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import {
  redactEvidenceText,
  sanitizeEvidenceJson,
} from "../runs/evidenceRedaction.js";

export type JobStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  space_id: string;
  user_id: string | null;
  project_folder_id: string | null;
  agent_id: string | null;
  job_type: string;
  status: JobStatus;
  priority: number;
  payload_json: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  scheduled_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEventRecord {
  id: string;
  job_id: string;
  event_type: string;
  message: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface JobReclaimResult {
  reclaimed_count: number;
  exhausted_jobs: Array<Pick<
    JobRecord,
    "id" | "space_id" | "user_id" | "job_type" | "attempts" | "max_attempts"
  >>;
}

export interface EnqueueJobInput {
  job_type: string;
  payload: Record<string, unknown>;
  space_id: string;
  user_id: string | null;
  project_folder_id?: string | null;
  agent_id?: string | null;
  priority?: number;
  max_attempts?: number;
  scheduled_at?: Date;
}

const JOB_SELECT_COLUMNS = `
  id, space_id, user_id, project_folder_id, agent_id, job_type, status, priority,
  payload_json, result_json, error, attempts, max_attempts, scheduled_at,
  claimed_by, claimed_at, started_at, completed_at, heartbeat_at,
  created_at, updated_at
`;

const TERMINAL_RUN_STATES = [
  "succeeded",
  "failed",
  "degraded",
  "cancelled",
  "orphaned",
  "waiting_for_review",
];

export class PgJobQueueRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgJobQueueRepository {
    if (!config.databaseUrl) {
      throw new Error("Job queue repository requires SERVER_DATABASE_URL");
    }
    return new PgJobQueueRepository(getDbPool(config.databaseUrl));
  }

  async enqueue(input: EnqueueJobInput, now: Date = new Date()): Promise<JobRecord> {
    const id = randomUUID();
    const result = await this.db.query<JobRecord>(
      `INSERT INTO jobs (
         id, space_id, user_id, project_folder_id, agent_id, job_type, status, priority,
         payload_json, attempts, max_attempts, scheduled_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'pending', $7,
         $8::jsonb, 0, $9, $10::timestamptz, $11::timestamptz, $11::timestamptz
       )
       RETURNING ${JOB_SELECT_COLUMNS}`,
      [
        id,
        input.space_id,
        input.user_id,
        input.project_folder_id ?? null,
        input.agent_id ?? null,
        input.job_type,
        input.priority ?? 0,
        JSON.stringify(sanitizeEvidenceJson(input.payload)),
        input.max_attempts ?? 3,
        (input.scheduled_at ?? now).toISOString(),
        now.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Job enqueue returned no row");
    return row;
  }

  async ensureAgentRunJob(
    input: EnqueueJobInput & { job_type: "agent_run" },
    now: Date = new Date(),
  ): Promise<JobRecord> {
    const id = randomUUID();
    const payload = sanitizeEvidenceJson(input.payload);
    const result = await this.db.query<JobRecord>(
      `WITH existing AS (
         SELECT ${JOB_SELECT_COLUMNS}
           FROM jobs
          WHERE space_id = $1
            AND job_type = 'agent_run'
            AND payload_json->>'run_id' = $2
            AND status IN ('pending', 'claimed', 'running')
          ORDER BY created_at DESC
          LIMIT 1
       ), inserted AS (
         INSERT INTO jobs (
           id, space_id, user_id, project_folder_id, agent_id, job_type, status,
           priority, payload_json, attempts, max_attempts, scheduled_at,
           created_at, updated_at
         )
         SELECT $3, $1, $4, $5, $6, 'agent_run', 'pending',
                $7, $8::jsonb, 0, $9, $10::timestamptz, $11::timestamptz,
                $11::timestamptz
          WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING ${JOB_SELECT_COLUMNS}
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT * FROM existing
       LIMIT 1`,
      [
        input.space_id,
        String(input.payload.run_id ?? ""),
        id,
        input.user_id,
        input.project_folder_id ?? null,
        input.agent_id ?? null,
        input.priority ?? 0,
        JSON.stringify(payload),
        input.max_attempts ?? 3,
        (input.scheduled_at ?? now).toISOString(),
        now.toISOString(),
      ],
    );
    if (!result.rows[0]) {
      throw new Error("Agent Run job ensure returned no row");
    }
    return result.rows[0];
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const result = await this.db.query<JobRecord>(
      `SELECT ${JOB_SELECT_COLUMNS}
         FROM jobs
        WHERE id = $1`,
      [jobId],
    );
    return result.rows[0] ?? null;
  }

  async listJobs(input: {
    space_id: string;
    user_id?: string | null;
    status?: string | null;
    job_type?: string | null;
    limit: number;
    offset: number;
  }): Promise<JobRecord[]> {
    const params: unknown[] = [input.space_id];
    const clauses = ["space_id = $1"];
    if (input.user_id) {
      params.push(input.user_id);
      clauses.push(`user_id = $${params.length}`);
    }
    if (input.status) {
      params.push(input.status);
      clauses.push(`status = $${params.length}`);
    }
    if (input.job_type) {
      params.push(input.job_type);
      clauses.push(`job_type = $${params.length}`);
    }
    params.push(input.limit, input.offset);
    const result = await this.db.query<JobRecord>(
      `SELECT ${JOB_SELECT_COLUMNS}
         FROM jobs
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows;
  }

  async countJobs(input: {
    space_id: string;
    user_id?: string | null;
    status?: string | null;
  }): Promise<number> {
    const params: unknown[] = [input.space_id];
    const clauses = ["space_id = $1"];
    if (input.user_id) {
      params.push(input.user_id);
      clauses.push(`user_id = $${params.length}`);
    }
    if (input.status) {
      params.push(input.status);
      clauses.push(`status = $${params.length}`);
    }
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE ${clauses.join(" AND ")}`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Instance-wide queue depth for the operator status surface. Deliberately
   * not space-scoped and counts only — a backed-up worker is a property of the
   * process, not of one Space, and no row content is exposed.
   */
  async countQueueDepth(): Promise<{ pending: number; running: number }> {
    const result = await this.db.query<{ pending: string; running: string }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status IN ('claimed', 'running'))::text AS running
         FROM jobs`,
    );
    return {
      pending: Number(result.rows[0]?.pending ?? 0),
      running: Number(result.rows[0]?.running ?? 0),
    };
  }

  async getEvents(jobId: string): Promise<JobEventRecord[]> {
    const result = await this.db.query<JobEventRecord>(
      `SELECT id, job_id, event_type, message, data, created_at
         FROM job_events
        WHERE job_id = $1
        ORDER BY created_at ASC`,
      [jobId],
    );
    return result.rows;
  }

  async claimNext(
    workerId: string,
    jobTypes: readonly string[] | null,
    now: Date = new Date(),
  ): Promise<JobRecord | null> {
    const params: unknown[] = [workerId, now.toISOString()];
    let typeFilter = "";
    if (jobTypes && jobTypes.length > 0) {
      const placeholders = jobTypes.map((_, index) => `$${index + 3}`).join(", ");
      typeFilter = `AND job_type IN (${placeholders})`;
      params.push(...jobTypes);
    }

    const result = await this.db.query<JobRecord>(
      `WITH candidate AS (
         SELECT id AS candidate_job_id
          FROM jobs
          WHERE status = 'pending'
            AND scheduled_at <= $2::timestamptz
            AND attempts < max_attempts
            ${typeFilter}
          ORDER BY priority DESC, scheduled_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE jobs
          SET status = 'claimed',
              claimed_by = $1,
              claimed_at = $2::timestamptz,
              heartbeat_at = NULL,
              attempts = attempts + 1,
              updated_at = $2::timestamptz
         FROM candidate
        WHERE jobs.id = candidate.candidate_job_id
        RETURNING ${JOB_SELECT_COLUMNS}`,
      params,
    );
    return result.rows[0] ?? null;
  }

  async claimNextAgentRun(workerId: string, now?: Date): Promise<JobRecord | null> {
    return this.claimNext(workerId, ["agent_run"], now);
  }

  async startJob(
    jobId: string,
    workerId: string | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE jobs
          SET status = 'running',
              started_at = $2::timestamptz,
              heartbeat_at = $2::timestamptz,
              updated_at = $2::timestamptz
        WHERE id = $1
          AND status = 'claimed'
          AND (CAST($3 AS text) IS NULL OR claimed_by = $3)`,
      [jobId, now.toISOString(), workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async completeJob(
    jobId: string,
    resultJson: unknown,
    workerId: string | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE jobs
          SET status = 'completed',
              result_json = $2::jsonb,
              completed_at = $3::timestamptz,
              heartbeat_at = NULL,
              updated_at = $3::timestamptz
        WHERE id = $1
          AND status IN ('claimed', 'running')
          AND (CAST($4 AS text) IS NULL OR claimed_by = $4)`,
      [
        jobId,
        JSON.stringify(sanitizeEvidenceJson(resultJson ?? {})),
        now.toISOString(),
        workerId,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async failJob(
    jobId: string,
    error: string,
    workerId: string | null,
    now: Date = new Date(),
  ): Promise<JobStatus | null> {
    const result = await this.db.query<{ status: JobStatus }>(
      `UPDATE jobs
          SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
              error = $2,
              heartbeat_at = NULL,
              claimed_by = CASE WHEN attempts < max_attempts THEN NULL ELSE claimed_by END,
              claimed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE claimed_at END,
              started_at = CASE WHEN attempts < max_attempts THEN NULL ELSE started_at END,
              completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE $3::timestamptz END,
              updated_at = $3::timestamptz
        WHERE id = $1
          AND status IN ('claimed', 'running')
          AND (CAST($4 AS text) IS NULL OR claimed_by = $4)
        RETURNING status`,
      [jobId, redactEvidenceText(error), now.toISOString(), workerId],
    );
    return result.rows[0]?.status ?? null;
  }

  async deferJob(
    jobId: string,
    error: string,
    workerId: string | null,
    scheduledAt: Date,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE jobs
          SET status = 'pending',
              error = $2,
              scheduled_at = $3,
              attempts = GREATEST(0, attempts - 1),
              heartbeat_at = NULL,
              claimed_by = NULL,
              claimed_at = NULL,
              started_at = NULL,
              updated_at = $4
        WHERE id = $1
          AND status IN ('claimed', 'running')
          AND (CAST($5 AS text) IS NULL OR claimed_by = $5)`,
      [
        jobId,
        redactEvidenceText(error),
        scheduledAt.toISOString(),
        now.toISOString(),
        workerId,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async cancelJob(
    jobId: string,
    workerId: string | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    return withQueryableTransaction(this.db, async (db) => {
    const result = await db.query<{ id: string; run_id: string | null; run_space_id: string | null }>(
      `WITH cancelled_job AS (
         UPDATE jobs
            SET status = 'cancelled',
                heartbeat_at = NULL,
                completed_at = $2::timestamptz,
                updated_at = $2::timestamptz
          WHERE id = $1
            AND status IN ('pending', 'claimed', 'running')
            AND (CAST($3 AS text) IS NULL OR claimed_by = $3)
         RETURNING id, job_type, payload_json, space_id
       ),
       cancelled_run AS (
         UPDATE runs
            SET status = 'cancelled',
                ended_at = $2::timestamptz,
                updated_at = $2::timestamptz,
                error_message = 'Run cancelled',
                error_json = '{"error_code":"run_cancelled","error_text":"Run cancelled"}'::jsonb
           FROM cancelled_job
          WHERE cancelled_job.job_type = 'agent_run'
            AND runs.id::text = cancelled_job.payload_json->>'run_id'
            AND runs.status <> ALL($4::text[])
           RETURNING runs.id, runs.space_id
       )
       SELECT cancelled_job.id, cancelled_run.id AS run_id, cancelled_run.space_id AS run_space_id
         FROM cancelled_job
         LEFT JOIN cancelled_run ON true`,
      [jobId, now.toISOString(), workerId, TERMINAL_RUN_STATES],
    );
    for (const row of result.rows) {
      if (row.run_id && row.run_space_id) await projectTaskStatusFromRun(db, row.run_space_id, row.run_id);
    }
    return (result.rowCount ?? 0) > 0;
    });
  }

  async touchHeartbeat(
    jobId: string,
    workerId: string | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE jobs
          SET heartbeat_at = $2::timestamptz,
              updated_at = $2::timestamptz
        WHERE id = $1
          AND status IN ('claimed', 'running')
          AND (CAST($3 AS text) IS NULL OR claimed_by = $3)`,
      [jobId, now.toISOString(), workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async appendJobEvent(input: {
    job_id: string;
    event_type: string;
    message: string;
    data?: unknown;
    created_at?: Date;
  }): Promise<JobEventRecord> {
    const result = await this.db.query<JobEventRecord>(
      `INSERT INTO job_events (id, job_id, event_type, message, data, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
       RETURNING id, job_id, event_type, message, data, created_at`,
      [
        randomUUID(),
        input.job_id,
        input.event_type,
        redactEvidenceText(input.message) ?? "",
        JSON.stringify(sanitizeEvidenceJson(input.data ?? {})),
        (input.created_at ?? new Date()).toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("JobEvent append returned no row");
    return row;
  }

  async reclaimStuckJobs(
    stuckAfterSeconds = 600,
    now: Date = new Date(),
  ): Promise<JobReclaimResult> {
    const cutoff = new Date(now.getTime() - stuckAfterSeconds * 1000).toISOString();
    await this.deleteOrphanRunExecutionLocks(cutoff);

    const result = await withQueryableTransaction(this.db, async (db) => {
      const result = await db.query<{
      reclaimed_count: string | number;
      exhausted_jobs: JobReclaimResult["exhausted_jobs"] | null;
      failed_run_refs: Array<{ id: string; space_id: string }> | null;
    }>(
      `WITH retryable AS (
         UPDATE jobs
            SET status = 'pending',
                claimed_by = NULL,
                claimed_at = NULL,
                started_at = NULL,
                heartbeat_at = NULL,
                updated_at = $1::timestamptz
          WHERE status IN ('claimed', 'running')
            AND COALESCE(heartbeat_at, updated_at) < $2::timestamptz
            AND attempts < max_attempts
          RETURNING id, space_id, user_id, job_type, attempts, max_attempts
       ),
       exhausted_agent_runs AS (
         SELECT payload_json->>'run_id' AS run_id
           FROM jobs
          WHERE status IN ('claimed', 'running')
            AND job_type = 'agent_run'
            AND COALESCE(heartbeat_at, updated_at) < $2::timestamptz
            AND attempts >= max_attempts
            AND payload_json ? 'run_id'
       ),
       failed AS (
         UPDATE jobs
            SET status = 'failed',
                claimed_by = NULL,
                claimed_at = NULL,
                heartbeat_at = NULL,
                completed_at = $1::timestamptz,
                error = 'job stuck and retry attempts exhausted',
                updated_at = $1::timestamptz
          WHERE status IN ('claimed', 'running')
            AND COALESCE(heartbeat_at, updated_at) < $2::timestamptz
            AND attempts >= max_attempts
          RETURNING id, space_id, user_id, job_type, attempts, max_attempts
       ),
       failed_runs AS (
         UPDATE runs
            SET status = 'failed',
                ended_at = $1::timestamptz,
                updated_at = $1::timestamptz,
                error_message = 'run abandoned: backing job stuck and retry attempts exhausted',
                error_json = '{"error_code":"run_abandoned","error_text":"run abandoned: backing job stuck and retry attempts exhausted"}'::jsonb
           FROM exhausted_agent_runs
          WHERE runs.id::text = exhausted_agent_runs.run_id
            AND runs.status <> ALL($3::text[])
           RETURNING runs.id, runs.space_id
       )
       SELECT
         (SELECT COUNT(*) FROM retryable) + (SELECT COUNT(*) FROM failed)
           AS reclaimed_count,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object(
              'id', id,
              'space_id', space_id,
              'user_id', user_id,
              'job_type', job_type,
              'attempts', attempts,
              'max_attempts', max_attempts
            )) FROM failed),
           '[]'::jsonb
         ) AS exhausted_jobs,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('id', id, 'space_id', space_id)) FROM failed_runs),
           '[]'::jsonb
         ) AS failed_run_refs`,
      [now.toISOString(), cutoff, TERMINAL_RUN_STATES],
      );
      for (const run of result.rows[0]?.failed_run_refs ?? []) {
        await projectTaskStatusFromRun(db, run.space_id, run.id);
      }
      return result;
    });
    const count = result.rows[0]?.reclaimed_count ?? 0;
    return {
      reclaimed_count: Number(count),
      exhausted_jobs: result.rows[0]?.exhausted_jobs ?? [],
    };
  }

  private async deleteOrphanRunExecutionLocks(cutoff: string): Promise<void> {
    await this.db.query(
      `WITH stuck_agent_runs AS (
         SELECT id, payload_json->>'run_id' AS run_id
           FROM jobs
          WHERE status IN ('claimed', 'running')
            AND job_type = 'agent_run'
            AND COALESCE(heartbeat_at, updated_at) < $1
            AND payload_json ? 'run_id'
       )
       DELETE FROM run_execution_locks locks
        USING stuck_agent_runs
        WHERE locks.run_id::text = stuck_agent_runs.run_id
          AND (locks.job_id = stuck_agent_runs.id OR locks.job_id IS NULL)`,
      [cutoff],
    );
  }
}
