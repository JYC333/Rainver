import { describe, expect, it } from "vitest";
import type { RetrievalCalibrationDecisionRequest } from "@rainver/protocol";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import {
  persistRetrievalCalibrationDecisionArtifact,
  RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE,
  RetrievalCalibrationDecisionError,
} from "../src/modules/retrieval/artifacts/calibration.js";

function fakeDb(
  evidenceRows: Array<{ id: string; artifact_type: string; visibility: string }>,
) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (/SELECT a\.id, a\.artifact_type, a\.visibility\s+FROM artifacts a/.test(sql)) {
        return { rows: evidenceRows as Row[], rowCount: evidenceRows.length };
      }
      return { rows: [] as Row[], rowCount: 1 };
    },
  };
  return { db, calls };
}

describe("retrieval calibration decision artifacts", () => {
  it("accepts Memory maintenance reports as private calibration evidence refs", async () => {
    const evidenceArtifactId = "11111111-1111-4111-8111-111111111111";
    const { db, calls } = fakeDb([{
      id: evidenceArtifactId,
      artifact_type: "memory_maintenance_report",
      visibility: "private",
    }]);
    const request: RetrievalCalibrationDecisionRequest = {
      report_label: "Memory-linked calibration",
      review_scope: "private",
      decisions: [{
        mechanic: "richer_dedup",
        decision: "adopt",
        access_safety_proof: "Dedup uses only already-visible candidates and aggregate eval deltas.",
        eval_delta: { recall_10: 0.02 },
        evidence_artifact_ids: [evidenceArtifactId],
        guardrails: [],
      }],
    };

    const artifactId = await persistRetrievalCalibrationDecisionArtifact(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request,
    });

    expect(artifactId).toMatch(/[0-9a-f-]{36}/);
    const select = calls.find((call) => /SELECT a\.id, a\.artifact_type, a\.visibility\s+FROM artifacts a/.test(call.sql));
    expect(select?.params[2]).toContain("memory_maintenance_report");
    expect(select?.params[3]).toBe("user-1");
    expect(select?.sql).toContain("a.visibility IN ('private', 'space_shared')");
    const insert = calls.find((call) => /INSERT INTO artifacts/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[4]).toBe(RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE);
    expect(insert!.params[14]).toBe("private");
    expect(insert!.params[15]).toBe("user-1");
    const metadata = JSON.parse(String(insert!.params[13]));
    expect(metadata).toMatchObject({
      decision_summary: { adopt: 1 },
      evidence_artifacts: [{
        artifact_id: evidenceArtifactId,
        artifact_type: "memory_maintenance_report",
        visibility: "private",
      }],
      access_safety: {
        evidence_refs_only: true,
        ranking_behavior_changed: false,
      },
      retention_policy: {
        class: "aggregate_private_artifact",
        owner_scoped: true,
      },
    });
  });

  it("persists space_ops decisions only against shared evidence refs", async () => {
    const evidenceArtifactId = "22222222-2222-4222-8222-222222222222";
    const { db, calls } = fakeDb([{
      id: evidenceArtifactId,
      artifact_type: "retrieval_eval_report",
      visibility: "space_shared",
    }]);
    const request: RetrievalCalibrationDecisionRequest = {
      review_scope: "space_ops",
      decisions: [{
        mechanic: "autocut",
        decision: "adopt",
        access_safety_proof: "Autocut decisions are based on aggregate eval counters only.",
        eval_delta: { ndcg_10: 0.04 },
        evidence_artifact_ids: [evidenceArtifactId],
        guardrails: [],
      }],
    };

    await persistRetrievalCalibrationDecisionArtifact(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request,
    });

    const select = calls.find((call) => /SELECT a\.id, a\.artifact_type, a\.visibility\s+FROM artifacts a/.test(call.sql));
    expect(select?.sql).toContain("a.visibility = 'space_shared'");
    const insert = calls.find((call) => /INSERT INTO artifacts/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[14]).toBe("space_shared");
    const metadata = JSON.parse(String(insert!.params[13]));
    expect(metadata).toMatchObject({
      review_scope: "space_ops",
      visibility: "space_shared",
      retention_policy: {
        class: "aggregate_space_artifact",
        owner_scoped: false,
      },
    });
  });

  it("rejects missing or invisible evidence refs before inserting", async () => {
    const { db, calls } = fakeDb([]);
    const request: RetrievalCalibrationDecisionRequest = {
      review_scope: "space_ops",
      decisions: [{
        mechanic: "visible_edge_backlink",
        decision: "defer",
        access_safety_proof: "Needs a visible-edge-only count before shipping.",
        eval_delta: {},
        evidence_artifact_ids: ["33333333-3333-4333-8333-333333333333"],
        guardrails: [],
      }],
    };

    await expect(persistRetrievalCalibrationDecisionArtifact(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request,
    })).rejects.toMatchObject({
      name: "RetrievalCalibrationDecisionError",
      statusCode: 404,
    } satisfies Partial<RetrievalCalibrationDecisionError>);
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(false);
  });
});
