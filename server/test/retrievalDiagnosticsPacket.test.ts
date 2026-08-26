import { describe, expect, it } from "vitest";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import {
  createRetrievalDiagnosticsProposalPacket,
  registerRetrievalDiagnosticsProposalAppliers,
  RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE,
} from "../src/modules/retrieval/artifacts/diagnostics.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

function fakeDb(): Queryable & { calls: CapturedQuery[] } {
  const calls: CapturedQuery[] = [];
  return {
    calls,
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      // Every INSERT this fake handles (proposals, artifacts) puts the
      // generated id first; echo it back so callers relying on
      // `RETURNING id` (e.g. insertProposalRow) get a usable row.
      return { rows: [{ id: params[0] }] as Row[], rowCount: 1 };
    },
  };
}

const report = {
  source: "product_diagnostic",
  suite: "retrieval_quality_feedback_loop",
  report_label: "Weekly diagnostics",
  metrics: { low_coverage_rate: 0.5 },
  counts: { briefs_total: 2, low_coverage_briefs: 1 },
  cases: [],
  rank_attribution: { evidence_kind_counts: {}, matched_field_counts: {}, score_buckets: {} },
  diagnostic_codes: ["low_coverage", "trend_low_coverage_worse"],
};

describe("retrieval diagnostics packets", () => {
  it("creates a private review packet from aggregate diagnostics", async () => {
    const db = fakeDb();
    const proposalId = await createRetrievalDiagnosticsProposalPacket(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      artifactId: "artifact-1",
      report,
    });

    expect(proposalId).toMatch(/[0-9a-f-]{36}/);
    const params = db.calls[0]!.params;
    expect(params[3]).toBe(RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE);
    expect(params[14]).toBe("user-1");
    const payload = JSON.parse(String(params[10]));
    expect(payload).toMatchObject({
      operation: "retrieval_diagnostics_packet",
      report_artifact_id: "artifact-1",
      canonical_write_performed: false,
      recommended_actions: expect.any(Array),
    });
  });

  it("accepts diagnostics packets without canonical writes", async () => {
    const db = fakeDb();
    const registry = new ProposalApplierRegistry();
    registerRetrievalDiagnosticsProposalAppliers(registry);
    const applier = registry.get(RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE);
    expect(applier).not.toBeNull();

    const result = await applier!({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "packet-1",
        space_id: "space-1",
        proposal_type: RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE,
        title: "Diagnostics packet",
        payload_json: {
          operation: "retrieval_diagnostics_packet",
          report_artifact_id: "artifact-1",
          recommended_actions: [{ kind: "retrieval_quality_review" }],
        },
        project_folder_id: null,
        created_by_user_id: "user-1",
        created_by_run_id: null,
        project_id: null,
      },
    });

    expect(result).toMatchObject({
      result_type: "retrieval_diagnostics_packet",
      result: {
        report_artifact_id: "artifact-1",
        recommended_action_count: 1,
        canonical_write_performed: false,
      },
    });
    expect(db.calls.some((call) => /INSERT INTO knowledge_items/.test(call.sql))).toBe(false);
    expect(db.calls.some((call) => /INSERT INTO memory_entries/.test(call.sql))).toBe(false);
    // The applier only returns proposalPayloadPatch; ProposalApplyService
    // (server/src/modules/proposals/applyService.ts) is the layer that
    // actually issues `UPDATE proposals` from that patch, and is covered by
    // its own tests — this test exercises the applier in isolation.
    expect(result.proposalPayloadPatch).toMatchObject({
      accepted_by_user_id: "user-1",
      canonical_write_performed: false,
    });
  });
});
