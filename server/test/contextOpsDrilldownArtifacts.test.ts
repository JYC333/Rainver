import { describe, expect, it } from "vitest";
import { ContextOpsService } from "../src/modules/contextOps/service.js";
import { RetrievalRegistry } from "../src/modules/retrieval/registry.js";
import type { RetrievalDomainAdapter } from "../src/modules/retrieval/registry.js";

function emptyRegistry(): RetrievalRegistry {
  const adapter: RetrievalDomainAdapter = {
    objectTypes: ["knowledge_item"],
    async loadCanonical() { return null; },
    async revalidate() { return null; },
    async listObjectIds() { return []; },
  };
  const registry = new RetrievalRegistry();
  registry.register(adapter);
  return registry;
}

function artifactRow(id: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    artifact_type: type,
    title: `Report ${id}`,
    created_at: "2026-06-20T00:00:00.000Z",
    metadata_json: { surface: "knowledge_retrieval_maintenance", counts: { duplicate: 2 }, ...extra },
  };
}

class ArtifactDrilldownFakeDb {
  queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();

    // Maintenance packets (proposals table).
    if (/FROM proposals/.test(norm) && /proposal_type = ANY/.test(norm)) {
      return {
        rows: [
          {
            id: "pkt-1",
            proposal_type: "retrieval_maintenance_packet",
            status: "pending",
            title: "Maintenance packet",
            created_at: "2026-06-21T00:00:00.000Z",
            payload_json: { report_artifact_id: "art-m1" },
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    // Maintenance report artifacts (artifact_type = ANY(...)).
    if (/FROM artifacts/.test(norm) && /artifact_type = ANY/.test(norm)) {
      // Over-fetch (limit+1=3) ⇒ truncated.
      return {
        rows: [
          artifactRow("art-m1", "retrieval_maintenance_report"),
          artifactRow("art-m2", "memory_maintenance_report"),
          artifactRow("art-m3", "retrieval_maintenance_report"),
        ] as Row[],
        rowCount: 3,
      };
    }
    // Diagnostics artifacts (suite filter).
    if (/FROM artifacts/.test(norm) && /metadata_json->>'suite'/.test(norm)) {
      return {
        rows: [
          artifactRow("art-d1", "retrieval_eval_report", { suite: "retrieval_quality_feedback_loop", diagnostic_codes: ["low_coverage"] }),
        ] as Row[],
        rowCount: 1,
      };
    }
    // Recent context briefs (private, single artifact_type, no suite).
    if (/FROM artifacts/.test(norm) && params[2] === "retrieval_explain_report") {
      return {
        rows: [
          artifactRow("art-e1", "retrieval_explain_report", { diagnostic_codes: ["target_returned"] }),
        ] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM artifacts/.test(norm) && /visibility = 'private'/.test(norm)) {
      return {
        rows: [
          artifactRow("art-b1", "retrieval_brief", { surface: "knowledge_brief", counts: {} }),
        ] as Row[],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

const NOW = new Date("2026-06-25T12:00:00.000Z");

describe("ContextOpsService.getDrilldown artifact sections", () => {
  it("lists maintenance reports + packets and truncates the over-fetched page", async () => {
    const db = new ArtifactDrilldownFakeDb();
    const result = await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "maintenance_reports",
      limit: 2,
      registry: emptyRegistry(),
      includeAllSources: false,
      includeSpaceOpsReports: false,
      now: NOW,
    });

    expect(result.section).toBe("maintenance_reports");
    expect(result.artifacts.map((a) => a.artifact_id)).toEqual(["art-m1", "art-m2"]);
    expect(result.packets.map((p) => p.proposal_id)).toEqual(["pkt-1"]);
    expect(result.packets[0].report_artifact_id).toBe("art-m1");
    // 3 artifact rows fetched for a limit of 2 ⇒ truncated.
    expect(result.truncated).toBe(true);
    // Object/source lists stay empty for an artifact section.
    expect(result.objects).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it("lists diagnostics reports with diagnostic codes", async () => {
    const db = new ArtifactDrilldownFakeDb();
    const result = await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "diagnostics_reports",
      limit: 25,
      registry: emptyRegistry(),
      includeAllSources: false,
      now: NOW,
    });

    expect(result.section).toBe("diagnostics_reports");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ artifact_id: "art-d1", diagnostic_codes: ["low_coverage"] });
    expect(result.packets).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("lists recent context briefs", async () => {
    const db = new ArtifactDrilldownFakeDb();
    const result = await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "recent_briefs",
      limit: 25,
      registry: emptyRegistry(),
      includeAllSources: false,
      now: NOW,
    });

    expect(result.section).toBe("recent_briefs");
    expect(result.artifacts.map((a) => a.artifact_id)).toEqual(["art-b1"]);
    expect(result.artifacts[0].surface).toBe("knowledge_brief");
    expect(result.truncated).toBe(false);
  });

  it("lists retrieval explain reports", async () => {
    const db = new ArtifactDrilldownFakeDb();
    const result = await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "explain_reports",
      limit: 25,
      registry: emptyRegistry(),
      includeAllSources: false,
      now: NOW,
    });

    expect(result.section).toBe("explain_reports");
    expect(result.artifacts.map((a) => a.artifact_id)).toEqual(["art-e1"]);
    expect(result.artifacts[0].diagnostic_codes).toEqual(["target_returned"]);
    expect(result.packets).toEqual([]);
  });

  it("passes the space_ops flag through to the maintenance queries when allowed", async () => {
    const db = new ArtifactDrilldownFakeDb();
    await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "maintenance_reports",
      limit: 5,
      registry: emptyRegistry(),
      includeAllSources: false,
      includeSpaceOpsReports: true,
      now: NOW,
    });
    const artifactQuery = db.queries.find((q) => /artifact_type = ANY/.test(q.sql.replace(/\s+/g, " ")));
    // The includeSpaceOpsReports boolean is the last bound parameter ($6).
    expect(artifactQuery?.params).toEqual(expect.arrayContaining([true]));
  });
});
