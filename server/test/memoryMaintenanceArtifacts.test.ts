import { describe, expect, it } from "vitest";
import type { MemoryMaintenanceReport } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import {
  createMemoryMaintenanceProposalPacket,
  MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE,
  MEMORY_MAINTENANCE_REPORT_ARTIFACT_TYPE,
  persistMemoryMaintenanceReportArtifact,
  registerMemoryMaintenanceProposalAppliers,
} from "../src/modules/memory/maintenanceArtifacts";
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
      // `RETURNING id` (e.g. insertProposalRow) get a usable row.
      return { rows: [{ id: params[0] }] as Row[], rowCount: 1 };
    },
  };
}

function report(): MemoryMaintenanceReport {
  return {
    findings: [
      {
        kind: "duplicate",
        objects: [
          { object_type: "memory_entry", object_id: "memory-1", title: "A" },
          { object_type: "memory_entry", object_id: "memory-2", title: "A" },
        ],
        reason: "same normalized title",
      },
    ],
    counts: {
      duplicate: 1,
      stale: 0,
      thin: 0,
      lifecycle_drift: 0,
    },
    candidate_limit: 500,
    candidates_examined: 2,
    scanned: 2,
    truncated: false,
    access_safety: {
      owner_private: true,
      raw_content_included: false,
      snippets_included: false,
    },
  };
}

describe("Memory maintenance artifacts", () => {
  it("persists reports as owner-private artifacts", async () => {
    const db = fakeDb();
    const artifactId = await persistMemoryMaintenanceReportArtifact(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      report: report(),
      scanOptions: { limit: 50 },
    });

    expect(artifactId).toMatch(/[0-9a-f-]{36}/);
    expect(db.calls).toHaveLength(1);
    const params = db.calls[0]!.params;
    expect(params[1]).toBe("space-1");
    expect(params[4]).toBe(MEMORY_MAINTENANCE_REPORT_ARTIFACT_TYPE);
    expect(params[15]).toBe("user-1");
    const metadata = JSON.parse(String(params[13]));
    expect(metadata).toMatchObject({
      kind: MEMORY_MAINTENANCE_REPORT_ARTIFACT_TYPE,
      visibility: "private",
      owner_user_id: "user-1",
      findings: expect.any(Array),
      candidate_limit: 500,
      candidates_examined: 2,
      access_safety: {
        owner_private: true,
        raw_content_included: false,
        snippets_included: false,
        hidden_row_counts_included: false,
      },
      retention_policy: {
        raw_private_content_included: false,
      },
    });
  });

  it("creates a private memory maintenance packet proposal", async () => {
    const db = fakeDb();
    const proposalId = await createMemoryMaintenanceProposalPacket(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      artifactId: "artifact-1",
      report: report(),
      scanOptions: { limit: 50 },
    });

    expect(proposalId).toMatch(/[0-9a-f-]{36}/);
    expect(db.calls).toHaveLength(1);
    const params = db.calls[0]!.params;
    expect(params[1]).toBe("space-1");
    expect(params[3]).toBe(MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE);
    expect(params[14]).toBe("user-1");
    const payload = JSON.parse(String(params[10]));
    expect(payload).toMatchObject({
      operation: "memory_maintenance_packet",
      target_scope: "memory",
      report_artifact_id: "artifact-1",
      candidate_limit: 500,
      candidates_examined: 2,
      generated_child_proposal_ids: [],
      canonical_write_performed: false,
    });
  });

  it("accepts packets as acknowledgement only, without canonical Memory writes", async () => {
    const db = fakeDb();
    const registry = new ProposalApplierRegistry();
    registerMemoryMaintenanceProposalAppliers(registry);
    const applier = registry.get(MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE);
    expect(applier).not.toBeNull();

    const result = await applier!({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "packet-1",
        space_id: "space-1",
        proposal_type: MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE,
        title: "Memory maintenance packet",
        payload_json: {
          operation: "memory_maintenance_packet",
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
      result_type: "memory_maintenance_packet",
      result: {
        report_artifact_id: "artifact-1",
        generated_child_proposal_count: 0,
        canonical_write_performed: false,
      },
    });
    expect(db.calls.some((call) => /INSERT INTO memory_entries/.test(call.sql))).toBe(false);
    expect(db.calls.some((call) => /INSERT INTO proposals/.test(call.sql))).toBe(false);
    // The applier only returns proposalPayloadPatch; ProposalApplyService
    // is the layer that actually issues `UPDATE proposals` from that patch,
    // and is covered by its own tests — this test exercises the applier in
    // isolation.
    expect(result.proposalPayloadPatch).toMatchObject({
      accepted_by_user_id: "user-1",
      generated_child_proposal_count: 0,
      canonical_write_performed: false,
    });
  });

  it("accepting packets creates reviewed child Memory proposals without direct Memory writes", async () => {
    const db = fakeDb();
    const registry = new ProposalApplierRegistry();
    registerMemoryMaintenanceProposalAppliers(registry);
    const applier = registry.get(MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE);
    expect(applier).not.toBeNull();

    const result = await applier!({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "packet-1",
        space_id: "space-1",
        proposal_type: MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE,
        title: "Memory maintenance packet",
        payload_json: {
          operation: "memory_maintenance_packet",
          report_artifact_id: "artifact-1",
          findings: [
            {
              kind: "duplicate",
              objects: [
                { object_type: "memory_entry", object_id: "memory-1", title: "A" },
                { object_type: "memory_entry", object_id: "memory-2", title: "A" },
              ],
              reason: "same normalized title",
              confidence_tier: "high",
              proposed_action: {
                proposal_type: "memory_archive",
                target_memory_ids: ["memory-2"],
              },
            },
            {
              kind: "project_drift",
              objects: [
                { object_type: "memory_entry", object_id: "memory-3", title: "Project memory" },
              ],
              reason: "linked to a project but not scoped as project memory",
              confidence_tier: "medium",
              proposed_action: {
                proposal_type: "memory_update",
                target_memory_id: "memory-3",
                maintenance_action: "align_project_scope",
                target_scope: "project",
                project_id: "project-1",
              },
            },
            {
              kind: "stale",
              objects: [
                { object_type: "memory_entry", object_id: "memory-4", title: "Stale memory" },
              ],
              reason: "not confirmed recently",
              confidence_tier: "medium",
              proposed_action: {
                proposal_type: "memory_update",
                target_memory_id: "memory-4",
                maintenance_action: "reconfirm_stale_memory",
              },
            },
          ],
        },
        project_folder_id: null,
        created_by_user_id: "user-1",
        created_by_run_id: null,
        project_id: null,
        visibility: "private",
      },
    });

    expect(result).toMatchObject({
      result_type: "memory_maintenance_packet",
      result: {
        generated_child_proposal_count: 3,
        canonical_write_performed: false,
      },
    });
    expect(db.calls.some((call) => /INSERT INTO memory_entries/.test(call.sql))).toBe(false);
    const childInserts = db.calls.filter((call) => /INSERT INTO proposals/.test(call.sql));
    expect(childInserts).toHaveLength(3);
    expect(childInserts.map((call) => call.params[3])).toEqual(["memory_archive", "memory_update", "memory_update"]);
    const archivePayload = JSON.parse(String(childInserts[0]!.params[10]));
    expect(archivePayload).toMatchObject({
      operation: "memory_archive",
      target_memory_id: "memory-2",
      source_maintenance_packet_id: "packet-1",
      source_report_artifact_id: "artifact-1",
      canonical_write_performed: false,
    });
    const updatePayload = JSON.parse(String(childInserts[1]!.params[10]));
    expect(updatePayload).toMatchObject({
      operation: "update",
      target_memory_id: "memory-3",
      target_scope: "project",
      project_id: "project-1",
      source_maintenance_packet_id: "packet-1",
      canonical_write_performed: false,
    });
    expect(result.proposalPayloadPatch?.generated_child_proposal_count).toBe(3);
    expect(result.proposalPayloadPatch?.generated_child_proposal_ids).toHaveLength(3);
  });

  it("keeps packet acceptance private to the creator", async () => {
    const db = fakeDb();
    const registry = new ProposalApplierRegistry();
    registerMemoryMaintenanceProposalAppliers(registry);
    const applier = registry.get(MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE);
    expect(applier).not.toBeNull();

    await expect(
      applier!({
        config: {} as never,
        db,
        userId: "admin-1",
        proposal: {
          id: "packet-1",
          space_id: "space-1",
          proposal_type: MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE,
          title: "Memory maintenance packet",
          payload_json: {
            operation: "memory_maintenance_packet",
            report_artifact_id: "artifact-1",
          },
          project_folder_id: null,
          created_by_user_id: "user-1",
          created_by_run_id: null,
          project_id: null,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
