import { describe, expect, it } from "vitest";
import { buildResearchReportReaderProjection } from "../src/modules/projectResearch/reportProjection.js";
import { resolveResearchReportReferences } from "../src/modules/projectResearch/reportReferenceResolver.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

describe("projectResearchReportProjection", () => {
  const report = {
    research_question: "Does X improve Y?", summary: "The evidence is mixed.",
    findings: [{ claim: "X helps.", support: "Two papers agree.", references: [{ arxiv_id: "1" }] }],
    sources: [{ title: "Paper", authors: ["A"], year: 2025, relevance: "relevant", summary: "Evidence.", references: [{ doi: "10/x" }] }],
    limitations: ["Small corpus"],
    ideas: [{ title: "Test X", problem: "Uncertainty", novelty: "New sample", testability: "Run benchmark", references: [{ source_item_id: "item-1" }] }],
  };

  describe("research report reader projection", () => {
    it("is stable and includes every user-facing section", () => {
      const first = buildResearchReportReaderProjection(report);
      const second = buildResearchReportReaderProjection(report);
      expect(second).toEqual(first);
      expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.normalizedText).toContain("Executive summary");
      expect(first.normalizedText).toContain("Two papers agree.");
      expect(first.normalizedText).toContain("Small corpus");
      expect(first.normalizedText).toContain("Run benchmark");
    });

    it("rewrites inline raw-id citation groups to the References panel labels", () => {
      const projection = buildResearchReportReaderProjection({
        ...report,
        summary: "Adaptive players converge faster [fc880096, 8fa13ba8]. Fixed weighting lags [9e9e9e9e].",
        findings: [
          { claim: "X helps.", support: "Truncated prefix cite [fc880096].", references: [{ evidence_id: "fc880096-79a8-4765-ae1f-0c282463691e" }] },
          { claim: "Y helps.", support: "Second cite.", references: [{ evidence_id: "8fa13ba8-9b59-46b8-8db3-8c54ba666903" }] },
        ],
      });
      expect(projection.normalizedText).toContain("Adaptive players converge faster [ref-1, ref-2].");
      // Unknown ids stay verbatim rather than being guessed into a wrong reference.
      expect(projection.normalizedText).toContain("Fixed weighting lags [9e9e9e9e].");
      expect(projection.normalizedText).toContain("Truncated prefix cite [ref-1].");
    });

    it("uses persisted two-level reference ids for labels and inline citations", () => {
      const projection = buildResearchReportReaderProjection({
        ...report,
        summary: "Cited inline [fc880096, 25919d08].",
        findings: [{
          claim: "X helps.", support: "Support.",
          references: [
            { evidence_id: "fc880096-79a8-4765-ae1f-0c282463691e", reference_id: "ref-1a" },
            { evidence_id: "25919d08-16eb-4c61-ac8b-9f4180d5a34b", reference_id: "ref-1b" },
            { evidence_id: "fc880096-79a8-4765-ae1f-0c282463691e", reference_id: "ref-1a" },
          ],
        }],
      });
      expect(projection.normalizedText).toContain("Cited inline [ref-1a, ref-1b].");
      expect(projection.normalizedText).toContain("References: [ref-1a]; [ref-1b]");
    });

    it("leaves ordinary bracketed prose and the reference list untouched", () => {
      const projection = buildResearchReportReaderProjection({
        ...report,
        summary: "Bracketed prose [not a citation] and a year [2025] survive.",
      });
      expect(projection.normalizedText).toContain("Bracketed prose [not a citation] and a year [2025] survive.");
      expect(projection.normalizedText).toContain("References: [ref-1]");
    });
  });
});

describe("projectResearchReportReferenceResolver", () => {
  class ReferenceDb implements Queryable {
    constructor(private readonly sourceRows: Record<string, unknown>[]) {}
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      expect(sql).toContain("content_access_grants");
      expect(sql).toContain("allowed_reader_user_ids");
      expect(params.slice(1)).toEqual(["space-1", "user-1"]);
      const sourceId = params[0]
      const rows = this.sourceRows.filter(row => row.id === sourceId).map(({ id: _id, ...row }) => row) as Row[]
      return { rows, rowCount: rows.length };
    }
  }

  const identity = { spaceId: "space-1", userId: "user-1" };

  describe("research report reference resolution", () => {
    it("returns readable metadata and replaces private source identifiers with stable references", async () => {
      const result = await resolveResearchReportReferences(new ReferenceDb([{
        id: "item-readable", title: "Readable source", metadata_json: { authors: ["Ada", "Lin"], year: 2025 },
        occurred_at: "2025-04-01T00:00:00.000Z", reference_object_id: "paper-1",
      }]), identity, {
        findings: [{ references: [{ source_item_id: "item-readable" }] }], sources: [], ideas: [],
      });
      expect(result.content).toEqual({ findings: [{ references: [{ reference_id: "ref-1" }] }], sources: [], ideas: [] });
      expect(result.resolved).toEqual([{
        id: "ref-1", availability: "available", title: "Readable source", authors: ["Ada", "Lin"], year: 2025,
        library_path: "/library/items/item-readable", academic_path: "/knowledge/sources?object=paper-1",
      }]);
    });

    it("does not disclose any metadata for an inaccessible source", async () => {
      const result = await resolveResearchReportReferences(new ReferenceDb([]), identity, {
        findings: [], sources: [{ references: [{ source_item_id: "secret-item", title: "Secret title" }] }], ideas: [],
      });
      expect(result.content).toEqual({ findings: [], sources: [{ references: [{ reference_id: "ref-1" }] }], ideas: [] });
      expect(result.resolved).toEqual([{ id: "ref-1", availability: "unavailable" }]);
      expect(JSON.stringify(result)).not.toContain("secret-item");
      expect(JSON.stringify(result)).not.toContain("Secret title");
    });
  });
});
