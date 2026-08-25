import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService";
import { InquirySignalService } from "../src/modules/inquiry/signalService";
import { InquiryGraphService } from "../src/modules/inquiry/graphService";
import { inquiryRetrievalAdapter } from "../src/modules/inquiry/retrievalAdapter";

// Real-Postgres coverage for the unified read plane: the Inquiry
// retrieval adapter feeding `retrieval_objects`, and the Inquiry/Combined
// Project graph producers. See plan section 15-16.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[inquiry-read-plane-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let PROJECT: string;

const identity = () => ({ spaceId: SPACE, userId: OWNER });
const outsiderIdentity = () => ({ spaceId: SPACE, userId: OUTSIDER });

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["retrieval_objects", "inquiry_signal_candidates", "inquiry_evidence_signals", "project_corpus_items", "space_objects", "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $3, $3), ($2, 'Outsider', 'active', $3, $3)`,
    [OWNER, OUTSIDER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  const project = await new PgProjectRepository(pool).create(identity(), { name: "Read Plane Project" });
  PROJECT = project.id as string;
});

async function createCorpusItem(): Promise<string> {
  const objectId = randomUUID();
  const corpusItemId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'source', 'A source', 'private', $3, $4, $4)`,
    [objectId, SPACE, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO project_corpus_items (id, space_id, project_id, object_id, role, status, triage_status, read_status, metadata_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'candidate', 'active', 'new', 'unread', '{}'::jsonb, $5, $5)`,
    [corpusItemId, SPACE, PROJECT, objectId, now],
  );
  return corpusItemId;
}

describe("Inquiry unified read plane (real Postgres)", () => {
  it("classifies Signals as referenced until their Candidate is accepted, then adopted", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const signalSvc = new InquirySignalService(pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "hypothesis", statement: "Adoption tier test" });

    const routineItem = await createCorpusItem();
    const routineSignal = await signalSvc.createSignal(identity(), PROJECT, thread.id as string, {
      corpus_item_id: routineItem,
      classification: "supports",
    });
    let listed = await signalSvc.listAllSignals(identity(), PROJECT);
    expect(listed.find((s) => s.id === routineSignal.id)?.reference_tier).toBe("referenced");

    const materialItem = await createCorpusItem();
    const materialSignal = await signalSvc.createSignal(identity(), PROJECT, thread.id as string, {
      corpus_item_id: materialItem,
      classification: "contradicts",
    });
    listed = await signalSvc.listAllSignals(identity(), PROJECT);
    expect(listed.find((s) => s.id === materialSignal.id)?.reference_tier).toBe("referenced");

    await signalSvc.decideCandidate(identity(), PROJECT, materialSignal.candidate_id as string, {
      decision: "accept",
      change_summary: "Confirmed via review",
      evaluation_state: "challenged",
    });
    listed = await signalSvc.listAllSignals(identity(), PROJECT);
    expect(listed.find((s) => s.id === materialSignal.id)?.reference_tier).toBe("adopted");
    // The unrelated routine Signal's tier is untouched by another Signal's Candidate decision.
    expect(listed.find((s) => s.id === routineSignal.id)?.reference_tier).toBe("referenced");
  });

  it("indexes a new Thread into retrieval_objects on creation and keeps it current after an Iteration", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Does caching reduce tail latency?" });

    const indexed = await pool.query<{ object_type: string; title: string }>(
      `SELECT object_type, title FROM retrieval_objects WHERE space_id = $1 AND object_id = $2`,
      [SPACE, thread.id],
    );
    expect(indexed.rows[0]).toEqual({ object_type: "inquiry_thread", title: "Does caching reduce tail latency?" });

    await iterationSvc.recordIteration(identity(), PROJECT, thread.id as string, {
      change_summary: "Benchmarked",
      current_answer_summary: "Yes, p95 drops 40%",
      answer_state: "partial",
    });
    const revalidated = await inquiryRetrievalAdapter.revalidate(pool, SPACE, "inquiry_thread", thread.id as string, OWNER);
    expect(revalidated?.text).toContain("Yes, p95 drops 40%");
  });

  it("revalidate denies a viewer who is not a Project member, even though the row is indexed", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Private-ish question" });
    const asOwner = await inquiryRetrievalAdapter.revalidate(pool, SPACE, "inquiry_thread", thread.id as string, OWNER);
    expect(asOwner).not.toBeNull();
    const asOutsider = await inquiryRetrievalAdapter.revalidate(pool, SPACE, "inquiry_thread", thread.id as string, OUTSIDER);
    expect(asOutsider).toBeNull();
  });

  it("drops a superseded Thread from the read plane", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Original" });
    await iterationSvc.reviseDefinition(identity(), PROJECT, thread.id as string, {
      revision_kind: "semantic_change",
      new_statement: "Completely different",
      structure_action: "supersede",
    });
    const canonical = await inquiryRetrievalAdapter.loadCanonical(pool, SPACE, "inquiry_thread", thread.id as string);
    expect(canonical).toBeNull();
  });

  it("produces an Inquiry graph with working-tier edges, and a Combined graph that still includes it", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const question = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Root question" });
    const hypothesis = await threadSvc.createThread(identity(), PROJECT, { kind: "hypothesis", statement: "A proposed answer" });
    await threadSvc.addRelation(identity(), PROJECT, {
      from_thread_id: question.id,
      to_thread_id: hypothesis.id,
      relation_kind: "proposes",
    });

    const graphSvc = new InquiryGraphService(pool);
    const inquiryGraph = await graphSvc.getInquiryGraph(identity(), PROJECT);
    expect(inquiryGraph.nodes).toHaveLength(2);
    expect(inquiryGraph.edges).toHaveLength(1);
    expect(inquiryGraph.edges[0]).toMatchObject({ kind: "proposes", metadata: { tier: "working" } });
    expect(new Set(inquiryGraph.nodes.map((n) => n.kind))).toEqual(new Set(["inquiry_question", "inquiry_hypothesis"]));

    const combined = await graphSvc.getCombinedProjectGraph(identity(), PROJECT, { limit: 300 });
    const combinedIds = new Set(combined.nodes.map((n) => n.id));
    expect(combinedIds.has(question.id as string)).toBe(true);
    expect(combinedIds.has(hypothesis.id as string)).toBe(true);
  });

  it("applies the requested node limit across the whole Combined graph", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "First" });
    await threadSvc.createThread(identity(), PROJECT, { kind: "hypothesis", statement: "Second" });
    await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Third" });

    const graph = await new InquiryGraphService(pool).getCombinedProjectGraph(
      identity(),
      PROJECT,
      { limit: 2 },
    );
    expect(graph.nodes).toHaveLength(2);
    expect(graph.view.limit).toBe(2);
    expect(graph.view.truncated).toBe(true);
    expect(graph.view.totalNodeCount).toBeGreaterThanOrEqual(3);
  });

  it("excludes a superseded Thread from the Inquiry graph", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Will be superseded" });
    await iterationSvc.reviseDefinition(identity(), PROJECT, thread.id as string, {
      revision_kind: "semantic_change",
      new_statement: "Replacement",
      structure_action: "supersede",
    });
    const graph = await new InquiryGraphService(pool).getInquiryGraph(identity(), PROJECT);
    expect(graph.nodes.some((n) => n.id === thread.id)).toBe(false);
    expect(graph.nodes.some((n) => n.label === "Replacement")).toBe(true);
  });

  it("keeps the Inquiry graph Space- and membership-gated", async () => {
    if (!available || !pool) return;
    const graphSvc = new InquiryGraphService(pool);
    await expect(graphSvc.getInquiryGraph(outsiderIdentity(), PROJECT)).rejects.toMatchObject({ statusCode: 404 });
  });
});
