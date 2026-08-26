import { afterEach, describe, expect, it, vi } from "vitest";
import { runContextObservationScan } from "../src/modules/contextOps/contextObservations.js";
import { ContextOpsService } from "../src/modules/contextOps/service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

class ObservationDb {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.calls.push({ sql, params });
    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe("Context Ops context observations", () => {
  it("generates a review-only artifact without canonical writes", async () => {
    vi.spyOn(ContextOpsService.prototype, "getSummary").mockResolvedValue({
      generated_at: "2026-06-29T00:00:00.000Z",
      source_policy_warnings: {
        warning_counts: {
          missing_consent_version: 1,
        },
      },
      embedding_backlog: {
        missing_embedding_chunks: 4,
      },
      maintenance: {
        pending_packet_count: 1,
        finding_counts: {
          stale: 2,
        },
      },
      memory_provenance: {
        context_injection_count: 3,
        maintenance_scan_count: 1,
      },
      recent_context_briefs: [
        {
          artifact_id: "brief-1",
          artifact_type: "retrieval_brief",
        },
      ],
    } as never);
    const db = new ObservationDb();

    const result = await runContextObservationScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        window_days: 1,
        limit: 25,
        persist_report: true,
      },
    });

    expect(result.canonical_write_performed).toBe(false);
    expect(result.report.access_safety).toEqual({
      aggregate_or_review_refs_only: true,
      raw_private_content_included: false,
      canonical_write_performed: false,
    });
    expect(result.report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "red", suggested_target: "review_only" }),
        expect.objectContaining({ severity: "yellow", suggested_target: "review_only" }),
      ]),
    );
    expect(result.artifact_id).toEqual(expect.any(String));
    const sql = db.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("INSERT INTO artifacts");
    expect(sql).not.toContain("INSERT INTO memory_entries");
    expect(sql).not.toContain("INSERT INTO knowledge_items");
    expect(sql).not.toContain("INSERT INTO capability");
    expect(sql).not.toContain("INSERT INTO proposals");
  });

  it("supports preview scans without writing artifacts", async () => {
    vi.spyOn(ContextOpsService.prototype, "getSummary").mockResolvedValue({
      generated_at: "2026-06-29T00:00:00.000Z",
      source_policy_warnings: { warning_counts: {} },
      embedding_backlog: { missing_embedding_chunks: 0 },
      maintenance: { pending_packet_count: 0, finding_counts: {} },
      memory_provenance: { context_injection_count: 0, maintenance_scan_count: 0 },
      recent_context_briefs: [],
    } as never);
    const db = new ObservationDb();

    const result = await runContextObservationScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        window_days: 1,
        limit: 25,
        persist_report: false,
      },
    });

    expect(result.artifact_id).toBeNull();
    expect(result.canonical_write_performed).toBe(false);
    expect(db.calls).toHaveLength(0);
    expect(result.report.observations[0]).toMatchObject({
      severity: "green",
      suggested_target: "review_only",
    });
  });
});
