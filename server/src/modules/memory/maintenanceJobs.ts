import { randomUUID } from "node:crypto";
import type {
  MemoryMaintenanceJob,
  MemoryMaintenanceJobCreateRequest,
  MemoryMaintenanceJobRunResponse,
  MemoryMaintenanceScanRequest,
} from "@rainver/protocol";
import type { Queryable } from "./repository.js";
import { PgMemoryReadRepository } from "./repository.js";
import { MemoryMaintenanceService } from "./maintenance.js";
import {
  createMemoryMaintenanceProposalPacket,
  persistMemoryMaintenanceReportArtifact,
} from "./maintenanceArtifacts.js";

interface MemoryMaintenanceJobRow {
  id: string;
  space_id: string;
  owner_user_id: string;
  status: "pending" | "running" | "completed" | "failed";
  review_scope: "private" | "space_ops";
  scan_options_json: unknown;
  cursor: string | null;
  total_scanned: number | string;
  total_findings: number | string;
  last_report_artifact_id: string | null;
  last_packet_proposal_id: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

export async function createMemoryMaintenanceJob(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    request: MemoryMaintenanceJobCreateRequest;
  },
): Promise<MemoryMaintenanceJob> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const options = normalizeJobScanOptions(input.request);
  const result = await db.query<MemoryMaintenanceJobRow>(
    `INSERT INTO memory_maintenance_jobs (
       id, space_id, owner_user_id, status, review_scope, scan_options_json,
       cursor, total_scanned, total_findings, last_report_artifact_id,
       last_packet_proposal_id, error_message, run_after, created_at, updated_at,
       completed_at
     ) VALUES (
       $1, $2, $3, 'pending', $4, $5::jsonb,
       NULL, 0, 0, NULL,
       NULL, NULL, $6, $6, $6,
       NULL
     )
     RETURNING id, space_id, owner_user_id, status, review_scope, scan_options_json,
               cursor, total_scanned, total_findings, last_report_artifact_id,
               last_packet_proposal_id, error_message, created_at, updated_at, completed_at`,
    [id, input.spaceId, input.ownerUserId, options.review_scope, JSON.stringify(options), now],
  );
  return jobFromRow(result.rows[0]!);
}

export async function getMemoryMaintenanceJob(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    jobId: string;
    includeSpaceOps: boolean;
  },
): Promise<MemoryMaintenanceJob | null> {
  const row = await loadVisibleJob(db, input);
  return row ? jobFromRow(row) : null;
}

export async function runMemoryMaintenanceJobOnce(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    jobId: string;
    includeSpaceOps: boolean;
  },
): Promise<MemoryMaintenanceJobRunResponse | null> {
  const row = await loadVisibleJob(db, { ...input, forUpdate: true });
  if (!row) return null;
  if (row.status === "completed" || row.status === "failed") {
    return { job: jobFromRow(row), report: null };
  }
  await db.query(
    `UPDATE memory_maintenance_jobs
        SET status = 'running', updated_at = now(), error_message = NULL
      WHERE id = $1 AND space_id = $2`,
    [row.id, row.space_id],
  );
  const options = normalizeJobScanOptions(record(row.scan_options_json));
  const savepointCreated = await createJobRunSavepoint(db);
  try {
    const scan = await new MemoryMaintenanceService(db).scan({
      spaceId: row.space_id,
      userId: row.owner_user_id,
      limit: options.limit,
      staleAfterDays: options.stale_after_days,
      thinContentChars: options.thin_content_chars,
      maxFindings: options.max_findings,
      projectId: options.project_id ?? null,
      scanMode: "full",
      cursor: row.cursor,
      excludePersonalVisibility: options.review_scope === "space_ops",
    });
    const scanOptions = {
      ...options,
      scan_mode: "full",
      cursor: row.cursor,
      job_id: row.id,
    };
    let artifactId: string | undefined;
    let proposalId: string | undefined;
    if (options.persist_report) {
      artifactId = await persistMemoryMaintenanceReportArtifact(db, {
        spaceId: row.space_id,
        ownerUserId: row.owner_user_id,
        report: scan.report,
        scanOptions,
        reviewScope: options.review_scope,
      });
      if (options.create_packet) {
        proposalId = await createMemoryMaintenanceProposalPacket(db, {
          spaceId: row.space_id,
          ownerUserId: row.owner_user_id,
          report: scan.report,
          scanOptions,
          artifactId,
          reviewScope: options.review_scope,
        });
      }
    }
    await new PgMemoryReadRepository(db).recordMaintenanceReads(
      scan.contributingMemoryIds,
      row.space_id,
      row.owner_user_id,
      artifactId ?? null,
    );
    const nextCursor = scan.report.next_cursor ?? null;
    const finalStatus = nextCursor ? "pending" : "completed";
    const updated = await updateJobAfterRun(db, {
      job: row,
      status: finalStatus,
      cursor: nextCursor,
      artifactId: artifactId ?? null,
      proposalId: proposalId ?? null,
      scanned: scan.report.scanned,
      findings: scan.report.findings.length,
    });
    return {
      job: updated,
      report: {
        ...scan.report,
        job_id: row.id,
        job_status: finalStatus,
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(proposalId ? { proposal_id: proposalId } : {}),
      },
    };
  } catch (error) {
    if (savepointCreated) {
      await db.query("ROLLBACK TO SAVEPOINT memory_maintenance_job_run");
    }
    const failed = await markJobFailed(db, row, error);
    return { job: failed, report: null };
  } finally {
    if (savepointCreated) {
      await db.query("RELEASE SAVEPOINT memory_maintenance_job_run").catch(() => {});
    }
  }
}

export async function runDueMemoryMaintenanceJobs(
  db: Queryable,
  limit = 5,
): Promise<number> {
  const due = await db.query<{ id: string; space_id: string; owner_user_id: string; review_scope: "private" | "space_ops" }>(
    `SELECT id, space_id, owner_user_id, review_scope
       FROM memory_maintenance_jobs
      WHERE status IN ('pending', 'running')
        AND (run_after IS NULL OR run_after <= now())
      ORDER BY updated_at ASC, id ASC
      LIMIT $1`,
    [limit],
  );
  let processed = 0;
  for (const job of due.rows) {
    await runMemoryMaintenanceJobOnce(db, {
      spaceId: job.space_id,
      userId: job.owner_user_id,
      jobId: job.id,
      includeSpaceOps: job.review_scope === "space_ops",
    });
    processed += 1;
  }
  return processed;
}

async function updateJobAfterRun(
  db: Queryable,
  input: {
    job: MemoryMaintenanceJobRow;
    status: "pending" | "completed";
    cursor: string | null;
    artifactId: string | null;
    proposalId: string | null;
    scanned: number;
    findings: number;
  },
): Promise<MemoryMaintenanceJob> {
  const result = await db.query<MemoryMaintenanceJobRow>(
    `UPDATE memory_maintenance_jobs
        SET status = $3::varchar(32),
            cursor = $4,
            total_scanned = total_scanned + $5,
            total_findings = total_findings + $6,
            last_report_artifact_id = COALESCE($7, last_report_artifact_id),
            last_packet_proposal_id = COALESCE($8, last_packet_proposal_id),
            updated_at = now(),
            completed_at = CASE WHEN $3::varchar(32) = 'completed' THEN now() ELSE completed_at END
      WHERE id = $1 AND space_id = $2
      RETURNING id, space_id, owner_user_id, status, review_scope, scan_options_json,
                cursor, total_scanned, total_findings, last_report_artifact_id,
                last_packet_proposal_id, error_message, created_at, updated_at, completed_at`,
    [
      input.job.id,
      input.job.space_id,
      input.status,
      input.cursor,
      input.scanned,
      input.findings,
      input.artifactId,
      input.proposalId,
    ],
  );
  return jobFromRow(result.rows[0]!);
}

async function markJobFailed(
  db: Queryable,
  row: MemoryMaintenanceJobRow,
  error: unknown,
): Promise<MemoryMaintenanceJob> {
  const message = error instanceof Error ? error.message : String(error);
  const result = await db.query<MemoryMaintenanceJobRow>(
    `UPDATE memory_maintenance_jobs
        SET status = 'failed', error_message = $3, updated_at = now(), completed_at = now()
      WHERE id = $1 AND space_id = $2
      RETURNING id, space_id, owner_user_id, status, review_scope, scan_options_json,
                cursor, total_scanned, total_findings, last_report_artifact_id,
                last_packet_proposal_id, error_message, created_at, updated_at, completed_at`,
    [row.id, row.space_id, message.slice(0, 2000)],
  );
  return jobFromRow(result.rows[0]!);
}

async function createJobRunSavepoint(db: Queryable): Promise<boolean> {
  try {
    await db.query("SAVEPOINT memory_maintenance_job_run");
    return true;
  } catch {
    return false;
  }
}

async function loadVisibleJob(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    jobId: string;
    includeSpaceOps: boolean;
    forUpdate?: boolean;
  },
): Promise<MemoryMaintenanceJobRow | null> {
  const result = await db.query<MemoryMaintenanceJobRow>(
    `SELECT id, space_id, owner_user_id, status, review_scope, scan_options_json,
            cursor, total_scanned, total_findings, last_report_artifact_id,
            last_packet_proposal_id, error_message, created_at, updated_at, completed_at
       FROM memory_maintenance_jobs
      WHERE id = $1
        AND space_id = $2
        AND (
          owner_user_id = $3
          OR ($4::boolean AND review_scope = 'space_ops')
        )
      LIMIT 1
      ${input.forUpdate ? "FOR UPDATE" : ""}`,
    [input.jobId, input.spaceId, input.userId, input.includeSpaceOps],
  );
  return result.rows[0] ?? null;
}

type NormalizedJobScanOptions = Required<Pick<
  MemoryMaintenanceScanRequest,
  "persist_report" | "create_packet" | "limit" | "stale_after_days" | "thin_content_chars" | "max_findings" | "review_scope"
>> & {
  project_id: string | null;
  scan_mode: "full";
};

function normalizeJobScanOptions(value: unknown): NormalizedJobScanOptions {
  const input = record(value);
  return {
    persist_report: input.persist_report !== false,
    create_packet: input.create_packet === true,
    limit: clampInt(input.limit, 500, 1, 1000),
    stale_after_days: clampInt(input.stale_after_days, 180, 1, 3650),
    thin_content_chars: clampInt(input.thin_content_chars, 80, 1, 1000),
    max_findings: clampInt(input.max_findings, 100, 1, 200),
    review_scope: input.review_scope === "space_ops" ? "space_ops" : "private",
    project_id: typeof input.project_id === "string" && input.project_id.trim() ? input.project_id.trim() : null,
    scan_mode: "full",
  };
}

function jobFromRow(row: MemoryMaintenanceJobRow): MemoryMaintenanceJob {
  return {
    id: row.id,
    space_id: row.space_id,
    owner_user_id: row.owner_user_id,
    status: row.status,
    review_scope: row.review_scope,
    scan_options: record(row.scan_options_json),
    cursor: row.cursor,
    total_scanned: intValue(row.total_scanned),
    total_findings: intValue(row.total_findings),
    last_report_artifact_id: row.last_report_artifact_id,
    last_packet_proposal_id: row.last_packet_proposal_id,
    error_message: row.error_message,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    completed_at: row.completed_at ? asIso(row.completed_at) : null,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : fallback;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function intValue(value: number | string): number {
  return typeof value === "number" ? Math.max(0, Math.trunc(value)) : Math.max(0, Math.trunc(Number(value) || 0));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class MemoryMaintenanceJobError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "MemoryMaintenanceJobError";
  }
}
