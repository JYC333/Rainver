import { beforeEach, describe, expect, it, vi } from "vitest";
import { runContextReviewCycle } from "../src/modules/contextOps/reviewCycle";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common";

const summaryMock = vi.hoisted(() => vi.fn());
const retrievalScanMock = vi.hoisted(() => vi.fn());
const memoryScanMock = vi.hoisted(() => vi.fn());
const memoryReadsMock = vi.hoisted(() => vi.fn());
const readSettingsMock = vi.hoisted(() => vi.fn());
const persistRetrievalMaintenanceMock = vi.hoisted(() => vi.fn());
const createRetrievalMaintenancePacketMock = vi.hoisted(() => vi.fn());
const buildDiagnosticsMock = vi.hoisted(() => vi.fn());
const persistDiagnosticsMock = vi.hoisted(() => vi.fn());
const createDiagnosticsPacketMock = vi.hoisted(() => vi.fn());
const persistMemoryMaintenanceMock = vi.hoisted(() => vi.fn());
const createMemoryMaintenancePacketMock = vi.hoisted(() => vi.fn());
const createClaimCandidatePacketMock = vi.hoisted(() => vi.fn());

vi.mock("../src/modules/contextOps/service", () => ({
  ContextOpsService: vi.fn(function () {
    return {
      getSummary: summaryMock,
    };
  }),
}));

vi.mock("../src/modules/retrieval/settings", () => ({
  readSpaceRetrievalSettings: readSettingsMock,
}));

vi.mock("../src/modules/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/retrieval")>();
  return {
    ...actual,
    RetrievalMaintenanceService: vi.fn(function () {
      return {
        scan: retrievalScanMock,
      };
    }),
    persistRetrievalMaintenanceReportArtifact: persistRetrievalMaintenanceMock,
    createRetrievalMaintenanceProposalPacket: createRetrievalMaintenancePacketMock,
    buildRetrievalEvalDiagnosticsReport: buildDiagnosticsMock,
    persistRetrievalEvalReportArtifact: persistDiagnosticsMock,
    createRetrievalDiagnosticsProposalPacket: createDiagnosticsPacketMock,
  };
});

vi.mock("../src/modules/memory/maintenance", () => ({
  MemoryMaintenanceService: vi.fn(function () {
    return {
      scan: memoryScanMock,
    };
  }),
}));

vi.mock("../src/modules/memory/maintenanceArtifacts", () => ({
  persistMemoryMaintenanceReportArtifact: persistMemoryMaintenanceMock,
  createMemoryMaintenanceProposalPacket: createMemoryMaintenancePacketMock,
}));

vi.mock("../src/modules/memory/repository", () => ({
  PgMemoryReadRepository: vi.fn(function () {
    return {
      recordMaintenanceReads: memoryReadsMock,
    };
  }),
}));

vi.mock("../src/modules/knowledge/claimCandidatePackets", () => ({
  createClaimCandidatePacketFromArtifacts: createClaimCandidatePacketMock,
}));

class ContextReviewCycleFakeDb implements Queryable {
  readonly artifactInserts: Array<Record<string, unknown>> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("INSERT INTO artifacts")) {
      this.artifactInserts.push({
        id: params[0],
        artifact_type: params[4],
        metadata_json: JSON.parse(String(params[13])),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("Context Review Cycle service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSettingsMock.mockResolvedValue({
      defaultSearchMode: "hybrid",
      rerankEnabled: false,
      queryRewriteEnabled: false,
      useQueryCache: true,
      includeTrace: false,
      externalEgressEnabled: true,
      retrievalToolMode: "off",
      embeddingDimensions: 2560,
      maxResultsDefault: 50,
    });
    summaryMock.mockResolvedValue({
      source_policy_warnings: {
        active_source_connections: 0,
        missing_consent_version_count: 0,
        reader_restricted_source_count: 0,
        external_egress_disabled_source_count: 0,
        derived_writes_disabled_source_count: 0,
        warning_counts: {},
      },
      index_freshness: {
        object_counts: {},
        stale_projection_count: 0,
        source_connected_object_count: 0,
        oldest_indexed_at: null,
        newest_indexed_at: null,
        newest_source_updated_at: null,
      },
      embedding_backlog: {
        total_chunks: 0,
        embedded_chunks: 0,
        missing_embedding_chunks: 0,
        claimed_chunks: 0,
        attempted_chunks: 0,
        missing_by_object_type: {},
      },
      recent_context_briefs: [
        {
          artifact_id: "artifact-brief",
          title: "Recent Context Brief",
          created_at: "2026-06-26T00:00:00.000Z",
        },
      ],
    });
    retrievalScanMock.mockResolvedValue({
      findings: [],
      counts: {},
      scanned: 0,
      truncated: false,
    });
    buildDiagnosticsMock.mockResolvedValue({
      diagnostic_codes: [],
      counts: {},
    });
    persistRetrievalMaintenanceMock.mockResolvedValue("artifact-maintenance");
    persistDiagnosticsMock.mockResolvedValue("artifact-diagnostics");
    createRetrievalMaintenancePacketMock.mockResolvedValue("proposal-maintenance");
    createDiagnosticsPacketMock.mockResolvedValue("proposal-diagnostics");
    memoryScanMock.mockResolvedValue({
      report: {
        findings: [{ kind: "stale", reason: "old memory" }],
        counts: { stale: 1 },
        scanned: 3,
        truncated: false,
      },
      contributingMemoryIds: ["memory-1"],
    });
    persistMemoryMaintenanceMock.mockResolvedValue("artifact-memory");
    createMemoryMaintenancePacketMock.mockResolvedValue("proposal-memory");
    memoryReadsMock.mockResolvedValue(undefined);
    createClaimCandidatePacketMock.mockResolvedValue({
      artifactId: "artifact-claim-candidates",
      proposalId: "proposal-claim-candidates",
      candidateCount: 4,
      sourceArtifactCount: 4,
      generatedChildProposalCount: 0,
    });
  });

  it("does not create review packets when create_packets is false", async () => {
    const db = new ContextReviewCycleFakeDb();
    const result = await runContextReviewCycle(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        window_days: 14,
        artifact_limit: 50,
        create_packets: false,
        review_scope: "private",
        include_memory_maintenance: false,
        memory_limit: 500,
        memory_stale_after_days: 180,
        memory_thin_content_chars: 80,
        memory_max_findings: 100,
        max_claim_candidates: 40,
      },
      runId: "run-1",
    });

    expect(createRetrievalMaintenancePacketMock).not.toHaveBeenCalled();
    expect(createDiagnosticsPacketMock).not.toHaveBeenCalled();
    expect(createMemoryMaintenancePacketMock).not.toHaveBeenCalled();
    expect(createClaimCandidatePacketMock).not.toHaveBeenCalled();
    expect(result.claim_candidates).toMatchObject({
      artifact_id: null,
      proposal_id: null,
      candidate_count: 0,
    });
    expect(result.degraded).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(db.artifactInserts[0]).toMatchObject({
      artifact_type: "context_review_cycle_report",
    });
  });

  it("creates claim candidate packets from recent briefs and generated maintenance artifacts", async () => {
    const db = new ContextReviewCycleFakeDb();
    const result = await runContextReviewCycle(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        window_days: 14,
        artifact_limit: 50,
        create_packets: true,
        review_scope: "private",
        include_memory_maintenance: true,
        memory_limit: 500,
        memory_stale_after_days: 180,
        memory_thin_content_chars: 80,
        memory_max_findings: 100,
        max_claim_candidates: 40,
      },
      runId: "run-1",
    });

    expect(createRetrievalMaintenancePacketMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      artifactId: "artifact-maintenance",
      reviewScope: "private",
    }));
    expect(createDiagnosticsPacketMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      artifactId: "artifact-diagnostics",
      reviewScope: "private",
    }));
    expect(createMemoryMaintenancePacketMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      artifactId: "artifact-memory",
      reviewScope: "private",
    }));
    expect(createClaimCandidatePacketMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      request: {
        source_artifact_ids: [
          "artifact-brief",
          "artifact-maintenance",
          "artifact-diagnostics",
          "artifact-memory",
        ],
        max_candidates: 40,
        review_scope: "private",
        promote_private_sources_to_space_ops: false,
      },
    }));
    expect(result.claim_candidates).toMatchObject({
      artifact_id: "artifact-claim-candidates",
      proposal_id: "proposal-claim-candidates",
      candidate_count: 4,
      generated_child_proposal_count: 0,
    });
    expect(result.degraded).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(memoryReadsMock).toHaveBeenCalledWith(["memory-1"], "space-1", "user-1", "artifact-memory");
  });

  it("does not include recent private briefs in space_ops claim candidate packets", async () => {
    const db = new ContextReviewCycleFakeDb();
    await runContextReviewCycle(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        window_days: 14,
        artifact_limit: 50,
        create_packets: true,
        review_scope: "space_ops",
        include_memory_maintenance: false,
        memory_limit: 500,
        memory_stale_after_days: 180,
        memory_thin_content_chars: 80,
        memory_max_findings: 100,
        max_claim_candidates: 40,
      },
      runId: "run-1",
    });

    expect(createClaimCandidatePacketMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      request: {
        source_artifact_ids: [
          "artifact-maintenance",
          "artifact-diagnostics",
        ],
        max_candidates: 40,
        review_scope: "space_ops",
        promote_private_sources_to_space_ops: false,
      },
    }));
  });

  it("keeps the Context Review Cycle report when optional claim packet creation fails", async () => {
    createClaimCandidatePacketMock.mockRejectedValueOnce(new Error("claim packet failed"));
    const db = new ContextReviewCycleFakeDb();
    const result = await runContextReviewCycle(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        window_days: 14,
        artifact_limit: 50,
        create_packets: true,
        review_scope: "private",
        include_memory_maintenance: false,
        memory_limit: 500,
        memory_stale_after_days: 180,
        memory_thin_content_chars: 80,
        memory_max_findings: 100,
        max_claim_candidates: 40,
      },
      runId: "run-1",
    });

    expect(result.degraded).toBe(true);
    expect(result.warnings).toEqual([
      {
        stage: "claim_candidate_packet",
        error_code: "claim_candidate_packet_failed",
        message: "claim packet failed",
      },
    ]);
    expect(result.claim_candidates).toMatchObject({
      artifact_id: null,
      proposal_id: null,
      candidate_count: 0,
      generated_child_proposal_count: 0,
      error_code: "claim_candidate_packet_failed",
      error_message: "claim packet failed",
    });
    expect(db.artifactInserts[0]).toMatchObject({
      artifact_type: "context_review_cycle_report",
      metadata_json: expect.objectContaining({
        degraded: true,
        warnings: result.warnings,
      }),
    });
  });
});
