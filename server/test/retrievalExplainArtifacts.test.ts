import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  persistRetrievalExplainReportArtifact,
  RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE,
} from "../src/modules/retrieval/artifacts/explain.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// The report settles on real PostgreSQL: its target must be releasable to the
// owner (and the owner a Space maintainer) when the row is written.
const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), item = randomUUID();
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project: randomUUID() });
  await insertKnowledgeItem(db.pool, { id: item, spaceId: space, title: "Visible Item", content: "Visible body", ownerUserId: owner, createdByUserId: owner });
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(space);
});

describe("retrieval explain artifacts", () => {
  it("persists targeted explain reports without query text or snippets", async () => {
    const artifactId = await persistRetrievalExplainReportArtifact(db.pool, {
      spaceId: space,
      ownerUserId: owner,
      query: "private roadmap query",
      mode: "lexical",
      maxResults: 10,
      response: {
        target: {
          object_type: "knowledge_item",
          object_id: item,
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
    const row = (await db.pool.query("SELECT artifact_type, owner_user_id, metadata_json, content FROM artifacts WHERE id=$1", [artifactId])).rows[0]!;
    expect(row.artifact_type).toBe(RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE);
    expect(row.owner_user_id).toBe(owner);
    const metadata = row.metadata_json;
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
    expect(String(row.content)).not.toContain("private roadmap query");
  });
});
