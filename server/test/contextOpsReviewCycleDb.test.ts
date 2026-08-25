import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import type { RetrievalBriefResponse } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { runContextReviewCycle } from "../src/modules/contextOps/reviewCycle";
import { persistRetrievalBriefArtifact } from "../src/modules/retrieval/artifacts/brief";
import { RetrievalProjectionService } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALPHA_1 = "00000000-0000-4000-8000-000000000101";
const ALPHA_2 = "00000000-0000-4000-8000-000000000102";
const THIN = "00000000-0000-4000-8000-000000000103";
const LINKER = "00000000-0000-4000-8000-000000000104";
const TARGET = "00000000-0000-4000-8000-000000000105";

const LONG = "This object has enough searchable operational content to avoid being classified as thin.";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[context-ops-review-cycle-db] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["content_access_logs", "memory_entries", "artifacts", "proposals", "object_relations", "claims", "retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Context Review Cycle DB', 'personal', now(), now())`,
    [SPACE],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now())`,
    [USER],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('context-review-owner', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, USER],
  );
});

async function seedKnowledge(): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id: ALPHA_1,
    spaceId: SPACE,
    title: "Alpha Concept",
    content: `Alpha one. ${LONG}`,
    ownerUserId: USER,
    createdByUserId: USER,
  });
  await insertKnowledgeItem(pool!, {
    id: ALPHA_2,
    spaceId: SPACE,
    title: "Alpha Concept",
    content: `Alpha two. ${LONG}`,
    ownerUserId: USER,
    createdByUserId: USER,
  });
  await insertKnowledgeItem(pool!, {
    id: THIN,
    spaceId: SPACE,
    title: "Tiny",
    content: "x",
    ownerUserId: USER,
    createdByUserId: USER,
  });
  await insertKnowledgeItem(pool!, {
    id: LINKER,
    spaceId: SPACE,
    title: "Linker Page",
    content: `See [[Target Page]] for details. ${LONG}`,
    ownerUserId: USER,
    createdByUserId: USER,
  });
  await insertKnowledgeItem(pool!, {
    id: TARGET,
    spaceId: SPACE,
    title: "Target Page",
    content: `Target. ${LONG}`,
    ownerUserId: USER,
    createdByUserId: USER,
  });
  await new RetrievalProjectionService(pool!, knowledgeRetrievalRegistry).reindexAll(SPACE);
}

async function seedRecentBrief(): Promise<string> {
  return persistRetrievalBriefArtifact(pool!, {
    spaceId: SPACE,
    ownerUserId: USER,
    query: "Where are the claim gaps?",
    objectTypes: ["knowledge_item"],
    maxResults: 5,
    mode: "hybrid",
    includeTrace: false,
    surface: "context_ops_test",
    response: {
      brief: {
        answer: "Alpha needs a sourced claim review.",
        synthesized: true,
        citations: [],
        gap_analysis: {
          low_coverage: false,
          uncited_claims: ["Alpha Concept needs source-backed review."],
          contradictions: [],
          missing_topics: ["Alpha provenance"],
          stale: [{
            object_type: "knowledge_item",
            object_id: ALPHA_1,
            title: "Alpha Concept",
            reason: "Brief flagged this object as stale.",
          }],
          thin: [{
            object_type: "knowledge_item",
            object_id: THIN,
            title: "Tiny",
            reason: "Brief flagged this object as thin.",
          }],
        },
      },
      items: [],
      total: 0,
      trace: null,
    } as unknown as RetrievalBriefResponse,
    egressPolicySnapshot: {
      external_egress_enabled: true,
    },
  });
}

describe("Context Review Cycle (real Postgres)", () => {
  it("persists maintenance, diagnostics, claim packet, and Context Review Cycle report without canonical writes", async () => {
    if (!available || !pool) return;
    await seedKnowledge();
    const briefArtifactId = await seedRecentBrief();

    const result = await runContextReviewCycle(pool, {
      spaceId: SPACE,
      userId: USER,
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
      runId: null,
    });

    expect(result.degraded).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.retrieval_maintenance.artifact_id).toBeTruthy();
    expect(result.retrieval_maintenance.proposal_id).toBeTruthy();
    expect(result.diagnostics.artifact_id).toBeTruthy();
    expect(result.diagnostics.proposal_id).toBeTruthy();
    expect(result.claim_candidates.artifact_id).toBeTruthy();
    expect(result.claim_candidates.proposal_id).toBeTruthy();
    expect(result.claim_candidates.candidate_count).toBeGreaterThan(0);

    const artifacts = await pool.query<{ artifact_type: string; n: string }>(
      `SELECT artifact_type, count(*) AS n
         FROM artifacts
        WHERE space_id = $1
        GROUP BY artifact_type`,
      [SPACE],
    );
    const artifactCounts = Object.fromEntries(artifacts.rows.map((row) => [row.artifact_type, Number(row.n)]));
    expect(artifactCounts.retrieval_brief).toBe(1);
    expect(artifactCounts.retrieval_maintenance_report).toBe(1);
    expect(artifactCounts.retrieval_eval_report).toBe(1);
    expect(artifactCounts.claim_candidate_packet).toBe(1);
    expect(artifactCounts.context_review_cycle_report).toBe(1);

    const proposals = await pool.query<{ proposal_type: string; n: string }>(
      `SELECT proposal_type, count(*) AS n
         FROM proposals
        WHERE space_id = $1
        GROUP BY proposal_type`,
      [SPACE],
    );
    const proposalCounts = Object.fromEntries(proposals.rows.map((row) => [row.proposal_type, Number(row.n)]));
    expect(proposalCounts.retrieval_maintenance_packet).toBe(1);
    expect(proposalCounts.retrieval_diagnostics_packet).toBe(1);
    expect(proposalCounts.claim_candidate_packet).toBe(1);

    const packet = await pool.query<{ metadata_json: Record<string, unknown> }>(
      `SELECT metadata_json
         FROM artifacts
        WHERE id = $1 AND space_id = $2 AND artifact_type = 'claim_candidate_packet'`,
      [result.claim_candidates.artifact_id, SPACE],
    );
    const metadata = packet.rows[0]!.metadata_json;
    const sourceArtifactIds = Array.isArray(metadata.source_artifacts)
      ? metadata.source_artifacts.map((item) => String((item as { artifact_id?: unknown }).artifact_id))
      : [];
    expect(sourceArtifactIds).toContain(briefArtifactId);
    expect(sourceArtifactIds).toContain(result.retrieval_maintenance.artifact_id);
    expect(sourceArtifactIds).toContain(result.diagnostics.artifact_id);

    const claimRows = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM claims WHERE space_id = $1`, [SPACE]);
    const relationRows = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM object_relations WHERE space_id = $1`, [SPACE]);
    expect(claimRows.rows[0]!.n).toBe("0");
    expect(relationRows.rows[0]!.n).toBe("0");
  });
});
