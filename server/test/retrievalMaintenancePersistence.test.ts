import { describe, expect, it } from "vitest";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import {
  createRetrievalMaintenanceProposalPacket,
  persistRetrievalMaintenanceReportArtifact,
  registerRetrievalMaintenanceProposalAppliers,
  RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE,
  RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE,
} from "../src/modules/retrieval/maintenance/artifacts";
import type { MaintenanceReport } from "../src/modules/retrieval";
import type { Queryable } from "../src/modules/routeUtils/common";

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
      // `RETURNING id` (e.g. insertProposalRow) get a usable row. The
      // lineage-key lookup SELECT must keep returning "not found" so
      // create-packet calls don't short-circuit on a fake match.
      if (/^\s*INSERT/i.test(sql)) {
        return { rows: [{ id: params[0] }] as Row[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function report(): MaintenanceReport {
  return {
    findings: [
      {
        kind: "relation_suggestion",
        objects: [
          { object_type: "knowledge_item", object_id: "item-a", title: "A" },
          { object_type: "knowledge_item", object_id: "item-b", title: "B" },
        ],
        reason: "suggested related_to relation from extracted links",
        proposed_action: {
          proposal_type: "object_relation_create",
          title: "Relate: A -> B",
          payload: {
            operation: "object_relation_create",
            from_object_id: "item-a",
            to_object_id: "item-b",
            relation_type: "related_to",
            status: "candidate",
            confidence: null,
            evidence_summary: "suggested related_to relation from extracted links",
          },
        },
      },
      {
        kind: "thin",
        objects: [{ object_type: "knowledge_item", object_id: "item-c", title: "C" }],
        reason: "sparse searchable content",
      },
    ],
    counts: { duplicate: 0, orphan: 0, thin: 1, stale: 0, relation_suggestion: 1 },
    scanned: 3,
    truncated: false,
  };
}

describe("retrieval maintenance persistence", () => {
  it("persists maintenance reports as owner-private artifacts", async () => {
    const db = fakeDb();
    const artifactId = await persistRetrievalMaintenanceReportArtifact(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      report: report(),
      source: "knowledge_retrieval_maintenance",
    });

    expect(artifactId).toMatch(/[0-9a-f-]{36}/);
    expect(db.calls).toHaveLength(1);
    const params = db.calls[0]!.params;
    expect(params[1]).toBe("space-1");
    expect(params[4]).toBe(RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE);
    expect(params[15]).toBe("user-1");
    expect(params[2]).toBeNull();
    const metadata = JSON.parse(String(params[13]));
    expect(metadata).toMatchObject({
      kind: RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE,
      visibility: "private",
      owner_user_id: "user-1",
      scanned: 3,
    });
  });

  it("can link maintenance reports and packets to the automation run that produced them", async () => {
    const db = fakeDb();
    const artifactId = await persistRetrievalMaintenanceReportArtifact(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      runId: "run-1",
      report: report(),
      source: "automation_knowledge_retrieval_maintenance",
    });
    const proposalId = await createRetrievalMaintenanceProposalPacket(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      runId: "run-1",
      artifactId,
      report: report(),
      source: "automation_knowledge_retrieval_maintenance",
    });

    expect(proposalId).toMatch(/[0-9a-f-]{36}/);
    const artifactParams = db.calls[0]!.params;
    // db.calls[1] is createRetrievalMaintenanceProposalPacket's internal
    // lineage-key dedup lookup (a SELECT); the INSERT is [2].
    const proposalParams = db.calls[2]!.params;
    expect(artifactParams[2]).toBe("run-1");
    expect(proposalParams[2]).toBe("run-1");
    expect(JSON.parse(String(artifactParams[13]))).toMatchObject({ run_id: "run-1" });
    expect(JSON.parse(String(proposalParams[10]))).toMatchObject({ run_id: "run-1" });
  });

  it("creates a private batched maintenance packet proposal", async () => {
    const db = fakeDb();
    const proposalId = await createRetrievalMaintenanceProposalPacket(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      artifactId: "artifact-1",
      report: report(),
      source: "knowledge_retrieval_maintenance",
    });

    expect(proposalId).toMatch(/[0-9a-f-]{36}/);
    // db.calls[0] is the internal lineage-key dedup lookup (a SELECT).
    expect(db.calls).toHaveLength(2);
    const params = db.calls[1]!.params;
    expect(params[1]).toBe("space-1");
    expect(params[3]).toBe(RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE);
    expect(params[14]).toBe("user-1");
    const payload = JSON.parse(String(params[10]));
    expect(payload).toMatchObject({
      operation: "retrieval_maintenance_packet",
      report_artifact_id: "artifact-1",
      findings: expect.any(Array),
      generated_child_proposal_ids: [],
    });
  });

  it("accepting a packet creates child proposals, not canonical Knowledge rows", async () => {
    const db = fakeDb();
    const registry = new ProposalApplierRegistry();
    registerRetrievalMaintenanceProposalAppliers(registry);
    const applier = registry.get(RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE);
    expect(applier).not.toBeNull();

    const result = await applier!({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "packet-1",
        space_id: "space-1",
        proposal_type: RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE,
        title: "Maintenance packet",
        payload_json: {
          operation: "retrieval_maintenance_packet",
          report_artifact_id: "artifact-1",
          findings: report().findings,
        },
        project_folder_id: null,
        created_by_user_id: "user-1",
        created_by_run_id: null,
        project_id: null,
      },
    });

    expect(result).toMatchObject({
      result_type: "retrieval_maintenance_packet",
      result: {
        report_artifact_id: "artifact-1",
        generated_child_proposal_count: 1,
      },
    });
    expect(db.calls.some((call) => /INSERT INTO knowledge_items/.test(call.sql))).toBe(false);
    expect(db.calls.some((call) => /INSERT INTO object_relations/.test(call.sql))).toBe(false);
    // The applier only returns proposalPayloadPatch; ProposalApplyService
    // is the layer that actually issues `UPDATE proposals` from that patch,
    // and is covered by its own tests — this test exercises the applier in
    // isolation.
    expect(result.proposalPayloadPatch?.generated_child_proposal_ids).toHaveLength(1);
  });
});
