import { describe, expect, it } from "vitest";
import {
  createMemoryMaintenanceJob,
  runMemoryMaintenanceJobOnce,
} from "../src/modules/memory/maintenanceJobs";
import type { MemoryRow, Queryable } from "../src/modules/memory/repository";

interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

interface MemoryMaintenanceJobRow {
  id: string;
  space_id: string;
  owner_user_id: string;
  status: "pending" | "running" | "completed" | "failed";
  review_scope: "private" | "space_ops";
  scan_options_json: Record<string, unknown>;
  cursor: string | null;
  total_scanned: number;
  total_findings: number;
  last_report_artifact_id: string | null;
  last_packet_proposal_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

class FakeJobDb implements Queryable {
  calls: CapturedQuery[] = [];
  job: MemoryMaintenanceJobRow | null;

  constructor(
    private readonly memoryRows: MemoryRow[],
    options: { job?: MemoryMaintenanceJobRow; failOnScan?: boolean } = {},
  ) {
    this.job = options.job ?? null;
    this.failOnScan = options.failOnScan === true;
  }

  private readonly failOnScan: boolean;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.calls.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT INTO memory_maintenance_jobs")) {
      this.job = {
        id: String(params[0]),
        space_id: String(params[1]),
        owner_user_id: String(params[2]),
        status: "pending",
        review_scope: params[3] === "space_ops" ? "space_ops" : "private",
        scan_options_json: JSON.parse(String(params[4])),
        cursor: null,
        total_scanned: 0,
        total_findings: 0,
        last_report_artifact_id: null,
        last_packet_proposal_id: null,
        error_message: null,
        created_at: String(params[5]),
        updated_at: String(params[5]),
        completed_at: null,
      };
      return { rows: [this.job as Row], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT id, space_id, owner_user_id, status, review_scope")) {
      if (!this.job || this.job.id !== params[0] || this.job.space_id !== params[1]) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [this.job as Row], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE memory_maintenance_jobs SET status = 'running'")) {
      if (this.job) {
        this.job = { ...this.job, status: "running", error_message: null };
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("FROM memory_entries")) {
      if (this.failOnScan) throw new Error("scan failed");
      const limit = typeof params[2] === "number" ? params[2] : this.memoryRows.length;
      return { rows: this.memoryRows.slice(0, limit) as Row[], rowCount: this.memoryRows.length };
    }

    if (normalized.startsWith("INSERT INTO artifacts")) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO proposals")) {
      // insertProposalRow relies on RETURNING id.
      return { rows: [{ id: params[0] }] as Row[], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO content_access_logs")) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE memory_entries SET access_count")) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE memory_maintenance_jobs SET status = $3")) {
      if (!this.job) return { rows: [], rowCount: 0 };
      this.job = {
        ...this.job,
        status: params[2] as MemoryMaintenanceJobRow["status"],
        cursor: params[3] as string | null,
        total_scanned: this.job.total_scanned + Number(params[4] ?? 0),
        total_findings: this.job.total_findings + Number(params[5] ?? 0),
        last_report_artifact_id: (params[6] as string | null) ?? this.job.last_report_artifact_id,
        last_packet_proposal_id: (params[7] as string | null) ?? this.job.last_packet_proposal_id,
        updated_at: "2026-06-27T00:00:01.000Z",
        completed_at: params[2] === "completed" ? "2026-06-27T00:00:01.000Z" : this.job.completed_at,
      };
      return { rows: [this.job as Row], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE memory_maintenance_jobs SET status = 'failed'")) {
      if (!this.job) return { rows: [], rowCount: 0 };
      this.job = {
        ...this.job,
        status: "failed",
        error_message: String(params[2]).slice(0, 2000),
        updated_at: "2026-06-27T00:00:01.000Z",
        completed_at: "2026-06-27T00:00:01.000Z",
      };
      return { rows: [this.job as Row], rowCount: 1 };
    }

    return { rows: [] as Row[], rowCount: 0 };
  }
}

function job(overrides: Partial<MemoryMaintenanceJobRow> = {}): MemoryMaintenanceJobRow {
  return {
    id: "job-1",
    space_id: "space-1",
    owner_user_id: "user-1",
    status: "pending",
    review_scope: "private",
    scan_options_json: {
      persist_report: true,
      create_packet: true,
      limit: 5,
      stale_after_days: 365,
      thin_content_chars: 12,
      max_findings: 100,
      review_scope: "private",
      scan_mode: "full",
    },
    cursor: null,
    total_scanned: 0,
    total_findings: 0,
    last_report_artifact_id: null,
    last_packet_proposal_id: null,
    error_message: null,
    created_at: "2026-06-27T00:00:00.000Z",
    updated_at: "2026-06-27T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function memoryRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "memory-1",
    space_id: "space-1",
    subject_user_id: null,
    owner_user_id: "user-1",
    scope_type: "user",
    namespace: "user.default",
    memory_type: "fact",
    title: "Shared",
    content: "Long enough visible memory content.",
    status: "active",
    visibility: "private",
    sensitivity_level: "normal",
    access_level: "full",
    last_confirmed_at: null,
    confidence: 1,
    importance: 0.5,
    source_id: null,
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    version: 1,
    tags: [],
    memory_layer: "semantic",
    source_trust: "user_confirmed",
    created_from_proposal_id: null,
    root_memory_id: null,
    supersedes_memory_id: null,
    project_id: null,
    ...overrides,
  };
}

describe("Memory maintenance jobs", () => {
  it("creates normalized full-scan jobs", async () => {
    const db = new FakeJobDb([]);
    const created = await createMemoryMaintenanceJob(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        persist_report: true,
        scan_mode: "full",
        limit: 50,
        stale_after_days: 180,
        thin_content_chars: 80,
        max_findings: 100,
        create_packet: true,
        review_scope: "space_ops",
        project_id: null,
      },
    });

    expect(created.status).toBe("pending");
    expect(created.review_scope).toBe("space_ops");
    expect(created.scan_options).toMatchObject({
      scan_mode: "full",
      persist_report: true,
      create_packet: true,
      limit: 50,
      review_scope: "space_ops",
    });
  });

  it("runs one job page and persists report, packet, reads, and completed state", async () => {
    const db = new FakeJobDb([
      memoryRow({ id: "memory-1", title: "Shared" }),
      memoryRow({ id: "memory-2", title: "Shared" }),
    ], { job: job() });

    const result = await runMemoryMaintenanceJobOnce(db, {
      spaceId: "space-1",
      userId: "user-1",
      jobId: "job-1",
      includeSpaceOps: false,
    });

    expect(result).not.toBeNull();
    expect(result!.job.status).toBe("completed");
    expect(result!.job.total_scanned).toBe(2);
    expect(result!.job.total_findings).toBe(1);
    expect(result!.job.last_report_artifact_id).toMatch(/[0-9a-f-]{36}/);
    expect(result!.job.last_packet_proposal_id).toMatch(/[0-9a-f-]{36}/);
    expect(result!.report).toMatchObject({
      job_id: "job-1",
      job_status: "completed",
      counts: { duplicate: 1 },
      artifact_id: result!.job.last_report_artifact_id,
      proposal_id: result!.job.last_packet_proposal_id,
    });
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO artifacts"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO proposals"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO content_access_logs"))).toBe(true);
  });

  it("marks a job failed and returns report null when the page run fails", async () => {
    const db = new FakeJobDb([], { job: job(), failOnScan: true });

    const result = await runMemoryMaintenanceJobOnce(db, {
      spaceId: "space-1",
      userId: "user-1",
      jobId: "job-1",
      includeSpaceOps: false,
    });

    expect(result).toMatchObject({
      job: {
        id: "job-1",
        status: "failed",
        error_message: "scan failed",
      },
      report: null,
    });
    expect(db.calls.some((call) => call.sql.includes("SAVEPOINT memory_maintenance_job_run"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("ROLLBACK TO SAVEPOINT memory_maintenance_job_run"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("SET status = 'failed'"))).toBe(true);
  });
});
