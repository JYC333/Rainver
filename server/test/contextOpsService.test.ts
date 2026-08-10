import { describe, expect, it } from "vitest";
import { ContextOpsService } from "../src/modules/contextOps";

class FakeDb {
  queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();
    if (/FROM retrieval_objects/.test(norm)) {
      return {
        rows: [
          {
            object_type: "knowledge_item",
            total: 2,
            stale_projection_count: 1,
            source_connected_object_count: 1,
            oldest_indexed_at: "2026-06-01T00:00:00.000Z",
            newest_indexed_at: "2026-06-10T00:00:00.000Z",
            newest_source_updated_at: "2026-06-11T00:00:00.000Z",
          },
          {
            object_type: "claim",
            total: 1,
            stale_projection_count: 0,
            source_connected_object_count: 1,
            oldest_indexed_at: "2026-06-05T00:00:00.000Z",
            newest_indexed_at: "2026-06-12T00:00:00.000Z",
            newest_source_updated_at: null,
          },
        ] as Row[],
        rowCount: 2,
      };
    }
    if (/FROM retrieval_chunks/.test(norm) && /GROUP BY object_type/.test(norm)) {
      return { rows: [{ object_type: "claim", total: 3 }] as Row[], rowCount: 1 };
    }
    if (/FROM retrieval_chunks/.test(norm)) {
      return {
        rows: [
          {
            total_chunks: 10,
            embedded_chunks: 7,
            missing_embedding_chunks: 3,
            claimed_chunks: 1,
            attempted_chunks: 2,
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM source_connections/.test(norm)) {
      return {
        rows: [
          {
            active_source_connections: 4,
            missing_consent_version_count: 1,
            reader_restricted_source_count: 2,
            external_egress_disabled_source_count: 3,
            derived_writes_disabled_source_count: 1,
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM artifacts/.test(norm) && /artifact_type = ANY/.test(norm)) {
      return {
        rows: [
          {
            id: "artifact-maintenance",
            artifact_type: "memory_maintenance_report",
            title: "Memory Maintenance",
            created_at: "2026-06-20T00:00:00.000Z",
            metadata_json: {
              counts: { duplicate: 2 },
              findings: [{ kind: "thin", reason: "raw private content that must not leak" }],
            },
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM proposals/.test(norm)) {
      return {
        rows: [
          {
            id: "proposal-1",
            proposal_type: "memory_maintenance_packet",
            status: "pending",
            title: "Packet",
            created_at: "2026-06-21T00:00:00.000Z",
            payload_json: { report_artifact_id: "artifact-maintenance" },
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM artifacts/.test(norm) && /artifact_type = \$3/.test(norm) && params[2] === "retrieval_eval_report") {
      if (!/retrieval_quality_feedback_loop/.test(norm)) {
        return { rows: [] as Row[], rowCount: 0 };
      }
      return {
        rows: [
          {
            id: "artifact-eval",
            artifact_type: "retrieval_eval_report",
            title: "Eval",
            created_at: "2026-06-22T00:00:00.000Z",
            metadata_json: {
              generated_at: "2026-06-22T00:01:00.000Z",
              diagnostic_codes: ["low_coverage", "insufficient_trend_sample"],
              metrics: { recall_delta: -0.2, avg_recall: 0.5 },
            },
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM artifacts/.test(norm) && /artifact_type = \$3/.test(norm) && params[2] === "retrieval_brief") {
      return {
        rows: [
          {
            id: "artifact-brief",
            artifact_type: "retrieval_brief",
            title: "Brief",
            created_at: "2026-06-23T00:00:00.000Z",
            metadata_json: { surface: "knowledge_brief", diagnostic_codes: ["thin"] },
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM retrieval_feedback_events/.test(norm) && /GROUP BY signal_type/.test(norm)) {
      return { rows: [{ key: "opened", total: 2 }, { key: "used", total: 1 }] as Row[], rowCount: 2 };
    }
    if (/FROM retrieval_feedback_events/.test(norm) && /GROUP BY surface/.test(norm)) {
      return { rows: [{ key: "knowledge_brief", total: 3 }] as Row[], rowCount: 1 };
    }
    if (/FROM content_access_logs/.test(norm)) {
      return {
        rows: [
          {
            recent_access_count: 5,
            context_injection_count: 3,
            maintenance_scan_count: 1,
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("ContextOpsService", () => {
  it("builds an aggregate context ops summary without exposing artifact content", async () => {
    const db = new FakeDb();
    const summary = await new ContextOpsService(db).getSummary({
      spaceId: "space-1",
      userId: "user-1",
      windowDays: 14,
      limit: 10,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      space_id: "space-1",
      owner_user_id: "user-1",
      index_freshness: {
        object_counts: { claim: 1, knowledge_item: 2 },
        stale_projection_count: 1,
        source_connected_object_count: 2,
      },
      embedding_backlog: {
        total_chunks: 10,
        missing_embedding_chunks: 3,
        missing_by_object_type: { claim: 3 },
      },
      source_policy_warnings: {
        external_egress_disabled_source_count: 3,
      },
      maintenance: {
        recent_report_count: 1,
        finding_counts: { duplicate: 2 },
        pending_packet_count: 1,
      },
      diagnostics: {
        recent_report_count: 1,
        diagnostic_code_counts: { low_coverage: 1, insufficient_trend_sample: 1 },
        trend_metric_deltas: { recall_delta: -0.2 },
        insufficient_trend_sample: true,
      },
      retrieval_feedback: {
        recent_event_count: 3,
        signal_counts: { opened: 2, used: 1 },
        surface_counts: { knowledge_brief: 3 },
      },
      memory_provenance: {
        recent_access_count: 5,
        context_injection_count: 3,
        maintenance_scan_count: 1,
        inspector_available: true,
      },
    });
    expect(summary.recent_context_briefs[0]).toMatchObject({
      artifact_id: "artifact-brief",
      artifact_type: "retrieval_brief",
      title: "Brief",
      surface: "knowledge_brief",
    });
    expect(JSON.stringify(summary)).not.toContain("raw private content");
    const sourceWarningSql = db.queries.find((query) => /FROM source_connections/.test(query.sql))?.sql ?? "";
    expect(sourceWarningSql).toContain("IS DISTINCT FROM 'true'");
    expect(sourceWarningSql).toContain("consent_json ? 'schema_version'");
    expect(sourceWarningSql).toContain("consent_json->'allowed_reader_user_ids'");
    expect(sourceWarningSql).toContain("consent_json->>'allow_space_admins'");
    expect(db.queries.find((query) => /metadata_json->>'suite'/.test(query.sql))?.sql).toContain(
      "retrieval_quality_feedback_loop",
    );
    const sharedScopeQueries = db.queries.filter((query) => query.sql.includes("$6::boolean"));
    expect(sharedScopeQueries.length).toBeGreaterThanOrEqual(3);
    expect(sharedScopeQueries.every((query) => query.params[5] === false)).toBe(true);
  });

  it("enables shared space_ops report branches only when requested", async () => {
    const db = new FakeDb();
    await new ContextOpsService(db).getSummary({
      spaceId: "space-1",
      userId: "user-1",
      windowDays: 14,
      limit: 10,
      now: new Date("2026-06-25T12:00:00.000Z"),
      includeSpaceOpsReports: true,
    });

    const sharedScopeQueries = db.queries.filter((query) => query.sql.includes("$6::boolean"));
    expect(sharedScopeQueries.length).toBeGreaterThanOrEqual(3);
    expect(sharedScopeQueries.every((query) => query.params[5] === true)).toBe(true);
    expect(sharedScopeQueries.some((query) => query.sql.includes("metadata_json->>'review_scope' = 'space_ops'"))).toBe(true);
    expect(sharedScopeQueries.some((query) => query.sql.includes("payload_json->>'review_scope' = 'space_ops'"))).toBe(true);
  });
});
