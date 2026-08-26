import { describe, expect, it } from "vitest";
import {
  persistRetrievalExplainReportArtifact,
  RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE,
} from "../src/modules/retrieval/artifacts/explain.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

function fakeDb(): Queryable & { calls: CapturedQuery[] } {
  const calls: CapturedQuery[] = [];
  return {
    calls,
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}

describe("retrieval explain artifacts", () => {
  it("persists targeted explain reports without query text or snippets", async () => {
    const db = fakeDb();
    const artifactId = await persistRetrievalExplainReportArtifact(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      query: "private roadmap query",
      mode: "lexical",
      maxResults: 10,
      response: {
        target: {
          object_type: "knowledge_item",
          object_id: "item-1",
          title: "Visible Item",
          visible: true,
          returned: true,
          rank: 1,
          score: 0.9,
          score_bucket: "ge_0_75",
        },
        match: {
          matched_fields: ["title"],
          evidence_kind: "exact_title_match",
          evidence_field: "title",
          evidence_source: "exact",
          evidence_confidence: 1,
          create_safety: "exists",
        },
        trace: {
          arms: { exact: 1, lexical: 1 },
          dropped: 0,
          dropped_reasons: {},
          mode: "lexical",
          intent: "general",
        },
        diagnostic_codes: ["target_returned"],
      },
    });

    expect(artifactId).toMatch(/[0-9a-f-]{36}/);
    const params = db.calls[0]!.params;
    expect(params[4]).toBe(RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE);
    expect(params[15]).toBe("user-1");
    const metadata = JSON.parse(String(params[13]));
    expect(metadata).toMatchObject({
      kind: RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE,
      query_chars: 21,
      access_safety: {
        target_revalidated: true,
        aggregate_trace_only: true,
        content_included: false,
        snippets_included: false,
        dropped_candidate_ids_included: false,
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("private roadmap query");
  });
});
