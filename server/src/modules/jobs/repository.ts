import {hasJobEffectAuthority,authorizeJobEffect} from './effectAuthority.js';
import {withQueryableTransaction} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {withRunTerminalOwner} from '../systemActions/operations/proposalTransitions.js';
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";

import {
  redactEvidenceText,
  sanitizeEvidenceJson,
} from "../runs/evidenceRedaction.js";
import { PgRunRepository } from "../runs/repository.js";
import { wakeJobWorkers } from "./wakeSignal.js";
import { currentAgentRunJobSql, RUN_CANCELLATION_RECONCILE_JOB, SUPERSEDED_AGENT_RUN_JOB } from "./agentRunGeneration.js";


/**
 * A Job waiting on its next automatic attempt, due now: one that `failJob` or
 * stuck-Job reclaim put back to `pending` after a spent attempt (`attempts > 0`)
 * and that `claimNext` may take now. Not a first `pending` (no attempt yet), a
 * deferral still in the future, a `failed` Job (exhausted — nothing retries
 * it), or a source dispatch whose external outcome is unknown, which is never
 * repeated. A `jobs`-row predicate, for read models.
 */
export const JOB_RETRY_DUE_SQL = `status = 'pending' AND attempts > 0 AND attempts < max_attempts AND scheduled_at <= now() AND result_json->>'source_dispatch' IS DISTINCT FROM 'started'`;

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
  /** Candidates (or the orphan lock sweep, `job_id: null`) whose reclaim failed; the rest still ran. */
  failures?: Array<{ job_id: string | null; error: string }>;
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

/** Job types that perform a Run: their job ending without it ends the Run. */
const RUN_BACKED_JOB_TYPES = new Set(["agent_run", "provider_task_run", "daily_capture_report"]);
/** A completed Run or a parked Run has no work left on this Job. */
const RUN_NOT_ENDED_BY_JOB = new Set([
  "succeeded",
  "failed",
  "degraded",
  "cancelled",
  "orphaned",
  "waiting_for_review",
  "waiting_for_dependency",
]);

const CURRENT_AGENT_RUN_JOB = currentAgentRunJobSql();

/** The current agent Run job owes its launched latest attempt stop reconciliation. */
const LAUNCHED_AGENT_RUN_ACTIVE = `(${CURRENT_AGENT_RUN_JOB} AND EXISTS(SELECT 1 FROM runs r WHERE r.id=jobs.payload_json->>'run_id' AND r.space_id=jobs.space_id
  AND r.status IN ('running','cancelling') AND EXISTS(SELECT 1 FROM run_attempts a WHERE a.run_id=r.id AND a.space_id=r.space_id AND a.launch_id IS NOT NULL
    AND a.attempt_number=(SELECT max(latest.attempt_number) FROM run_attempts latest WHERE latest.run_id=r.id AND latest.space_id=r.space_id))))`;
/** An exhausted agent_run job whose launched attempt still runs keeps a reserved stop-reconciliation claim. */
const STOP_CLAIM_RESERVED = `(attempts >= max_attempts AND job_type='agent_run' AND ${LAUNCHED_AGENT_RUN_ACTIVE})`;

/**
 * Ends the Run a job was going to perform, through the Run repository's one
 * terminal write — proposals, attempt, locks — never by writing `runs`
 * here. A Run already ended, or parked for a person's decision, is left
 * alone. Finalization, and with it the Task's settlement, follows from the
 * jobs worker's sweep of unfinalized Task Runs.
 */
async function endRunBehindJob(
  db: Queryable,
  spaceId: string,
  runId: string,
  ending: { status: "cancelled" | "failed"; error_code: string; error_text: string; completed_at: string },
  agentJobId?: string,
): Promise<void> {
  const runs = new PgRunRepository(db);
  const run = await runs.getRun(spaceId, runId);
  if (!run || RUN_NOT_ENDED_BY_JOB.has(run.status)) return;
  await runs.markRunTerminal({
    run_id: runId,
    space_id: spaceId,
    status: ending.status,
    output_json: {},
    error_json: { error_code: ending.error_code, error_text: ending.error_text },
    completed_at: ending.completed_at,
    expected_agent_job_id: agentJobId,
  });
}

/**
 * A job scheduled for later is not claimable yet, so enqueuing one must not
 * wake a worker that would only find it still out of reach.
 */
function isClaimableNow(scheduledAt: Date | undefined, now: Date): boolean {
  return !scheduledAt || scheduledAt.getTime() <= now.getTime();
}

async function lockAgentRunJobs(db: Queryable, spaceId: string, runId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["agent_run_job", spaceId, runId])]);
}

/** The dispatch transition locks Run before rewriting old Jobs. Match that order. */
async function lockBackingRun(db: Queryable, jobId: string, nonWaiting = false): Promise<void> {
  await db.query(`SELECT run.id FROM jobs JOIN runs run
     ON run.space_id=jobs.space_id AND run.id=jobs.payload_json->>'run_id'
    WHERE jobs.id=$1 AND jobs.job_type=ANY($2::text[])
    FOR UPDATE OF run ${nonWaiting ? 'NOWAIT' : ''}`, [jobId, [...RUN_BACKED_JOB_TYPES]]);
}

export class PgJobQueueRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgJobQueueRepository {
    if (!config.databaseUrl) {
      throw new Error("Job queue repository requires SERVER_DATABASE_URL");
    }
    return new PgJobQueueRepository(getDbPool(config.databaseUrl));
  }

  async enqueue(input: EnqueueJobInput, now: Date = new Date()): Promise<JobRecord> {
    if(hasJobEffectAuthority())return withQueryableTransaction(this.db,async tx=>{
      await authorizeJobEffect(tx);
      return new PgJobQueueRepository(tx).enqueueAdmitted(input,now);
    });
    return this.enqueueAdmitted(input,now);
  }

  private async enqueueAdmitted(input:EnqueueJobInput,now:Date):Promise<JobRecord>{
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
    if (isClaimableNow(input.scheduled_at, now)) wakeJobWorkers();
    return row;
  }

  async ensureAgentRunJob(
    input: EnqueueJobInput & { job_type: "agent_run" },
    now: Date = new Date(),
  ): Promise<JobRecord> {
    return withQueryableTransaction(this.db, async tx => {
      if (hasJobEffectAuthority()) await authorizeJobEffect(tx);
      // Acquire before the lookup so a second READ COMMITTED transaction sees
      // the active job inserted by the caller that held this lock before it.
      await lockAgentRunJobs(tx, input.space_id, String(input.payload.run_id ?? ""));
      return new PgJobQueueRepository(tx).ensureAgentRunJobAdmitted(input, now);
    });
  }

  /** A stop has its own due Job, even while execution is scheduled or running. */
  async ensureRunCancellationJob(spaceId: string, runId: string): Promise<void> {
    await withQueryableTransaction(this.db, async db => {
      const cancelling = await db.query(`SELECT id FROM runs WHERE space_id=$1 AND id=$2 AND status='cancelling' FOR UPDATE`, [spaceId, runId]);
      if (!cancelling.rows.length) return;
      const existing = await db.query(`SELECT 1 FROM jobs WHERE space_id=$1 AND job_type=$2
        AND payload_json->>'run_id'=$3 AND status IN ('pending','claimed','running') LIMIT 1`,
        [spaceId, RUN_CANCELLATION_RECONCILE_JOB, runId]);
      if (!existing.rows.length) await new PgJobQueueRepository(db).enqueue({job_type: RUN_CANCELLATION_RECONCILE_JOB,
        space_id: spaceId, user_id: null, payload: {run_id: runId}});
    });
  }

  /** Retire the preceding dispatch in the transaction that requeues its Run.
   * An already-running predecessor can finish its own bookkeeping. */
  async supersedeAgentRunJobs(spaceId: string, runId: string): Promise<void> {
    await withQueryableTransaction(this.db, async db => {
      const queued = await db.query(`SELECT id FROM runs WHERE space_id=$1 AND id=$2 AND status='queued' FOR UPDATE`, [spaceId, runId]);
      if (!queued.rows.length) throw new Error("Agent Run must be queued before superseding its dispatch");
      await lockAgentRunJobs(db, spaceId, runId);
      await db.query(
        `UPDATE jobs SET payload_json = payload_json || jsonb_build_object('${SUPERSEDED_AGENT_RUN_JOB}', true),
                status = CASE WHEN status IN ('pending','claimed') THEN 'cancelled' ELSE status END,
                completed_at = CASE WHEN status IN ('pending','claimed') THEN now() ELSE completed_at END,
                updated_at = CASE WHEN status IN ('pending','claimed') THEN now() ELSE updated_at END
          WHERE space_id=$1 AND job_type='agent_run' AND payload_json->>'run_id'=$2
            AND status IN ('pending','claimed','running') AND ${CURRENT_AGENT_RUN_JOB}`,
        [spaceId, runId],
      );
    });
  }

  private async ensureAgentRunJobAdmitted(input:EnqueueJobInput & {job_type:'agent_run'},now:Date):Promise<JobRecord>{
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
            AND ${CURRENT_AGENT_RUN_JOB}
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
    if (isClaimableNow(input.scheduled_at, now)) wakeJobWorkers();
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
    job_type?: string | null;
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
    if (input.job_type) {
      params.push(input.job_type);
      clauses.push(`job_type = $${params.length}`);
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
      `SELECT count(*) FILTER (WHERE status = 'pending' AND scheduled_at <= now() AND attempts < max_attempts)::text AS pending,
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
              payload_json = CASE WHEN job_type='activity_upload' THEN payload_json-'input' ELSE payload_json END,
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

  /** A handler may settle its deterministic effect and Job in one transaction.
   * The worker independently verifies that exact receipt; an arbitrary terminal
   * status, stale attempt or another worker never counts as its completion. */
  async confirmCompletedJob(jobId:string,resultJson:unknown,workerId:string,attempt:number):Promise<boolean>{
    const row=await this.db.query(`SELECT id FROM jobs WHERE id=$1 AND status='completed'
      AND claimed_by=$2 AND attempts=$3 AND result_json=$4::jsonb`,
      [jobId,workerId,attempt,JSON.stringify(sanitizeEvidenceJson(resultJson??{}))]);
    return row.rows.length===1;
  }

  async failJob(
    jobId: string,
    error: string,
    workerId: string | null,
    now: Date = new Date(),
  ): Promise<JobStatus | null> {
    // The final failure of a Run-backed job ends its Run too, under the same
    // Run-terminal owner as cancel and reclaim; otherwise the Run stays queued
    // with nothing left to perform it. A launched agent_run attempt still
    // running owes its process a stop: like reclaim, the job keeps one
    // reserved claim (pending, attempts below the budget) so the handler's
    // stop reconciliation can confirm the Host exit and settle the Run; that
    // claim cannot dispatch a new physical attempt.
    return withRunTerminalOwner(this.db,async db=>(await db.query<{id:string;space_id:string}>(
      `SELECT payload_json->>'run_id' AS id,space_id FROM jobs WHERE id=$1
        AND job_type=ANY($2::text[]) AND payload_json->>'run_id' IS NOT NULL
        AND status IN ('claimed','running') AND attempts>=max_attempts AND ($3::text IS NULL OR claimed_by=$3)
        AND NOT(job_type='agent_run' AND ${LAUNCHED_AGENT_RUN_ACTIVE})`,[jobId,[...RUN_BACKED_JOB_TYPES],workerId])).rows,async db=>{
      await lockBackingRun(db, jobId);
      const result = await db.query<{ status: JobStatus; job_type: string; space_id: string; run_id: string | null; stop_claim: boolean }>(
        `WITH target AS (
           SELECT id, ${STOP_CLAIM_RESERVED} AS stop_claim,
                  job_type='agent_run' AND NOT ${CURRENT_AGENT_RUN_JOB} AS superseded FROM jobs
            WHERE id = $1 AND status IN ('claimed', 'running')
              AND (CAST($4 AS text) IS NULL OR claimed_by = $4)
         )
         UPDATE jobs
            SET status = CASE WHEN target.superseded THEN 'cancelled'
                           WHEN attempts < max_attempts OR target.stop_claim THEN 'pending' ELSE 'failed' END,
                attempts = CASE WHEN target.stop_claim THEN max_attempts - 1 ELSE attempts END,
                payload_json = CASE WHEN job_type='activity_upload' AND attempts>=max_attempts THEN payload_json-'input' ELSE payload_json END,
                error = $2,
                heartbeat_at = NULL,
                claimed_by = CASE WHEN attempts < max_attempts OR target.stop_claim THEN NULL ELSE claimed_by END,
                claimed_at = CASE WHEN attempts < max_attempts OR target.stop_claim THEN NULL ELSE claimed_at END,
                started_at = CASE WHEN attempts < max_attempts OR target.stop_claim THEN NULL ELSE started_at END,
                completed_at = CASE WHEN NOT target.superseded AND (attempts < max_attempts OR target.stop_claim)
                                    THEN NULL ELSE $3::timestamptz END,
                updated_at = $3::timestamptz
           FROM target
          WHERE jobs.id = target.id AND jobs.status IN ('claimed', 'running')
            AND (CAST($4 AS text) IS NULL OR jobs.claimed_by = $4)
          RETURNING jobs.status, jobs.job_type, jobs.space_id, jobs.payload_json->>'run_id' AS run_id,
            target.stop_claim`,
        [jobId, redactEvidenceText(error), now.toISOString(), workerId],
      );
      const job = result.rows[0];
      if (job?.status === "failed" && job.run_id && RUN_BACKED_JOB_TYPES.has(job.job_type) && !job.stop_claim) {
        await endRunBehindJob(db, job.space_id, job.run_id, {
          status: "failed",
          error_code: "run_abandoned",
          error_text: "run abandoned: backing job failed and retry attempts exhausted",
          completed_at: now.toISOString(),
        }, job.job_type === 'agent_run' ? jobId : undefined);
      }
      return job?.status ?? null;
    });
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
              -- A slot wake can race a claimed handler returning its old hold
              -- deadline. Its durable marker avoids comparing app and DB clocks.
              scheduled_at = CASE WHEN payload_json->>'_workspace_slot_woken'='true' THEN LEAST(scheduled_at,$3::timestamptz) ELSE $3::timestamptz END,
              payload_json = payload_json-'_workspace_slot_woken',
              attempts = GREATEST(0, attempts - 1),
              heartbeat_at = NULL,
              claimed_by = NULL,
              claimed_at = NULL,
              started_at = NULL,
              updated_at = $4
        WHERE id = $1
          AND status IN ('claimed', 'running')
          AND (CAST($5 AS text) IS NULL OR claimed_by = $5)
          AND (job_type <> 'agent_run' OR ${CURRENT_AGENT_RUN_JOB})`,
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

  /**
   * Cancels the job if it is still in one of `fromStatuses`, in the same
   * statement that checks it; returns whether it did. A caller that may not
   * cancel a running job (the person's route) names the statuses it accepts,
   * so a job that started between its read and this write stays as it is.
   */
  async cancelJob(
    jobId: string,
    workerId: string | null,
    now: Date = new Date(),
    fromStatuses: readonly string[] = ["pending", "claimed", "running"],
  ): Promise<boolean> {
    return withRunTerminalOwner(this.db,async db=>(await db.query<{id:string;space_id:string}>(
      `SELECT payload_json->>'run_id' AS id,space_id FROM jobs WHERE id=$1
        AND job_type=ANY($2::text[]) AND payload_json->>'run_id' IS NOT NULL
        AND status=ANY($3::text[]) AND ($4::text IS NULL OR claimed_by=$4)`,[jobId,[...RUN_BACKED_JOB_TYPES],[...fromStatuses],workerId])).rows,async db=>{
      await lockBackingRun(db, jobId);
      const result = await db.query<{ id: string; job_type: string; space_id: string; run_id: string | null }>(
        `UPDATE jobs
            SET status = 'cancelled',
                payload_json = CASE WHEN job_type='activity_upload' THEN payload_json-'input' ELSE payload_json END,
                error = CASE WHEN result_json->>'effect_started'='true' THEN 'Source dispatch cancelled after irreversible start; outcome unknown' ELSE error END,
                heartbeat_at = NULL,
                completed_at = $2::timestamptz,
                updated_at = $2::timestamptz
          WHERE id = $1
            AND status = ANY($4::text[])
            AND (CAST($3 AS text) IS NULL OR claimed_by = $3)
         RETURNING id, job_type, space_id, payload_json->>'run_id' AS run_id`,
        [jobId, now.toISOString(), workerId, [...fromStatuses]],
      );
      // Both Run-backed job types: cancelling the job that would have
      // performed a queued ProviderTask Run has to end that Run too, or the
      // person sees a cancelled job beside a Run still listed as queued.
      for (const job of result.rows) {
        if (job.run_id && RUN_BACKED_JOB_TYPES.has(job.job_type)) {
          await endRunBehindJob(db, job.space_id, job.run_id, {
            status: "cancelled",
            error_code: "run_cancelled",
            error_text: "Run cancelled",
            completed_at: now.toISOString(),
          }, job.job_type === 'agent_run' ? jobId : undefined);
        }
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
    const host=this.db as Queryable&{connect?:unknown;release?:unknown};
    if(typeof host.connect!=='function'||typeof host.release==='function')throw new HttpError(503,'Independent maintenance requires a Pool owner');
    const cutoff = new Date(now.getTime() - stuckAfterSeconds * 1000).toISOString();

    // Maintenance candidates are independent. A busy Run never aborts another
    // Job/Space, and orphan lock cleanup does not depend on request admission.
    // A failed candidate is reported, never allowed to stop the rest of the sweep.
    const total:JobReclaimResult={reclaimed_count:0,exhausted_jobs:[],failures:[]};
    const failed=(jobId:string|null,error:unknown)=>total.failures!.push({job_id:jobId,error:error instanceof Error?error.message:String(error)});
    await this.deleteOrphanRunExecutionLocks(cutoff).catch(error=>failed(null,error));
    const candidates=(await this.db.query<{id:string}>(`SELECT id FROM jobs WHERE status IN ('claimed','running')
      AND COALESCE(heartbeat_at,updated_at)<$1 ORDER BY id`,[cutoff])).rows;
    for(const candidate of candidates){
      try{
        const result=await this.reclaimStuckJob(candidate.id,cutoff,now);
        total.reclaimed_count+=result.reclaimed_count;total.exhausted_jobs.push(...result.exhausted_jobs);
      }catch(error){
        const code=(error as {code?:string}).code;
        if(code==='55P03'||code==='idempotency_in_progress'||code==='operation_conflict')continue;
        failed(candidate.id,error);
      }
    }
    return total;
  }

  private async reclaimStuckJob(jobId:string,cutoff:string,now:Date):Promise<JobReclaimResult>{
    const result = await withRunTerminalOwner(this.db,async db=>(await db.query<{id:string;space_id:string}>(
      `SELECT DISTINCT payload_json->>'run_id' AS id,space_id FROM jobs
        WHERE id=$3 AND status IN ('claimed','running') AND COALESCE(heartbeat_at,updated_at)<$1
          AND job_type=ANY($2::text[]) AND payload_json->>'run_id' IS NOT NULL AND attempts>=max_attempts
          AND NOT(job_type='agent_run' AND ${LAUNCHED_AGENT_RUN_ACTIVE})`,[cutoff,[...RUN_BACKED_JOB_TYPES],jobId])).rows,async db=>{
      await lockBackingRun(db, jobId, true);
      if(!(await db.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE SKIP LOCKED',[jobId])).rows.length)return {rows:[]};
      const result = await db.query<{
      reclaimed_count: string | number;
      exhausted_jobs: JobReclaimResult["exhausted_jobs"] | null;
      abandoned_runs: Array<{ space_id: string; run_id: string; job_type: string }> | null;
    }>(
      `WITH interrupted_agent_jobs AS (
         -- Even an exhausted job still owes its dispatched process a stop.
         -- Reclaim it for reconciliation, not another physical execution.
         SELECT id FROM jobs WHERE id=$4 AND job_type='agent_run' AND ${LAUNCHED_AGENT_RUN_ACTIVE}
       ), superseded_agent_job AS (
         UPDATE jobs SET status='cancelled', heartbeat_at=NULL, completed_at=$1, updated_at=$1
          WHERE id=$4 AND status IN ('claimed','running')
            AND COALESCE(heartbeat_at, updated_at) < $2::timestamptz
            AND job_type='agent_run' AND NOT ${CURRENT_AGENT_RUN_JOB}
         RETURNING id
       ), retryable AS (
         UPDATE jobs
            SET status = 'pending',
                -- Reserve a claim for stop reconciliation when the job budget
                -- is exhausted; this cannot dispatch a new physical attempt.
                attempts = CASE WHEN id IN (SELECT id FROM interrupted_agent_jobs)
                  THEN LEAST(attempts, max_attempts - 1) ELSE attempts END,
                claimed_by = NULL,
                claimed_at = NULL,
                started_at = NULL,
                heartbeat_at = NULL,
                updated_at = $1::timestamptz
          WHERE id=$4 AND status IN ('claimed', 'running')
            AND COALESCE(heartbeat_at, updated_at) < $2::timestamptz
            AND result_json->>'source_dispatch' IS DISTINCT FROM 'started'
            AND (job_type <> 'agent_run' OR ${CURRENT_AGENT_RUN_JOB})
            AND (attempts < max_attempts OR id IN (SELECT id FROM interrupted_agent_jobs))
          RETURNING id, space_id, user_id, job_type, attempts, max_attempts
       ),
       failed AS (
         UPDATE jobs
            SET status = 'failed',
                payload_json = CASE WHEN job_type='activity_upload' THEN payload_json-'input' ELSE payload_json END,
                claimed_by = NULL,
                claimed_at = NULL,
                heartbeat_at = NULL,
                completed_at = $1::timestamptz,
                error = CASE WHEN result_json->>'source_dispatch'='started' THEN 'Source dispatch outcome unknown; external work will not be repeated' ELSE 'job stuck and retry attempts exhausted' END,
                updated_at = $1::timestamptz
          WHERE id=$4 AND status IN ('claimed', 'running')
            AND COALESCE(heartbeat_at, updated_at) < $2::timestamptz
            AND (attempts >= max_attempts OR result_json->>'source_dispatch'='started')
            AND id NOT IN (SELECT id FROM interrupted_agent_jobs)
            AND (job_type <> 'agent_run' OR ${CURRENT_AGENT_RUN_JOB})
          RETURNING id, space_id, user_id, job_type, attempts, max_attempts, payload_json
       )
       SELECT
         (SELECT COUNT(*) FROM retryable) + (SELECT COUNT(*) FROM failed) + (SELECT COUNT(*) FROM superseded_agent_job)
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
         -- Both Run-backed job types, because both leave a Run behind when
         -- the job stops retrying: a provider_task_run job whose Run never
         -- started would otherwise sit queued forever, still spending its
         -- domain's daily budget, with nothing left to perform it.
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('space_id', space_id, 'run_id', payload_json->>'run_id', 'job_type', job_type))
              FROM failed
             WHERE job_type = ANY($3::text[]) AND payload_json->>'run_id' IS NOT NULL),
           '[]'::jsonb
         ) AS abandoned_runs`,
      [now.toISOString(), cutoff, [...RUN_BACKED_JOB_TYPES],jobId],
      );
      for (const run of result.rows[0]?.abandoned_runs ?? []) {
        await endRunBehindJob(db, run.space_id, run.run_id, {
          status: "failed",
          error_code: "run_abandoned",
          error_text: "run abandoned: backing job stuck and retry attempts exhausted",
          completed_at: now.toISOString(),
        }, run.job_type === 'agent_run' ? jobId : undefined);
      }
      return result;
    },{nonWaiting:true});
    const count = result.rows[0]?.reclaimed_count ?? 0;
    return {
      reclaimed_count: Number(count),
      exhausted_jobs: result.rows[0]?.exhausted_jobs ?? [],
    };
  }

  /**
   * Agent Runs only, on purpose: the execution lock is taken by
   * `RunOrchestrationService.executeRun`, and a bounded ProviderTask Run never
   * goes through it — `boundedProviderTaskRun.ts` performs the provider call
   * directly. There is no lock of a ProviderTask Run's for this to release.
   */
  private async deleteOrphanRunExecutionLocks(cutoff: string): Promise<void> {
    await this.db.query(
      `WITH stuck_agent_runs AS (
         SELECT id, payload_json->>'run_id' AS run_id
           FROM jobs
          WHERE status IN ('claimed', 'running')
            AND job_type = 'agent_run'
            AND ${CURRENT_AGENT_RUN_JOB}
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
