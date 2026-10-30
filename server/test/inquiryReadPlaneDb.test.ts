import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { InquirySignalService } from "../src/modules/inquiry/signalService.js";
import { InquiryAdviceService } from "../src/modules/inquiry/adviceService.js";
import type { ServerConfig } from "../src/config.js";
import { InquiryGraphService } from "../src/modules/inquiry/graphService.js";
import { inquiryRetrievalAdapter, inquiryRetrievalRegistry } from "../src/modules/inquiry/retrievalAdapter.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";

// Real-Postgres coverage for the unified read plane: the Inquiry
// retrieval adapter feeding `retrieval_objects`, and the Inquiry/Combined
// Project graph producers.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";


const db = useTestDatabase(import.meta.filename);

let PROJECT: string;

const identity = () => ({ spaceId: SPACE, userId: OWNER });
const outsiderIdentity = () => ({ spaceId: SPACE, userId: OUTSIDER });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "inquiry_signal_candidates", "inquiry_evidence_signals", "project_corpus_items", "space_objects", "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source) VALUES ($1, 'Owner', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system'), ($2, 'Outsider', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [OWNER, OUTSIDER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Read Plane Project" });
  PROJECT = project.id as string;
});

async function createCorpusItem(): Promise<string> {
  const objectId = randomUUID();
  const corpusItemId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'source', 'A source', 'private', $3, $4, $4)`,
    [objectId, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO project_corpus_items (id, space_id, project_id, object_id, role, status, triage_status, read_status, metadata_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'candidate', 'active', 'new', 'unread', '{}'::jsonb, $5, $5)`,
    [corpusItemId, SPACE, PROJECT, objectId, now],
  );
  return corpusItemId;
}

describe("Inquiry unified read plane (real Postgres)", () => {
  it("classifies Signals as referenced until their Candidate is accepted, then adopted", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const signalSvc = new InquirySignalService(db.pool);
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Does caching reduce tail latency?" });

    const indexed = await db.pool.query<{ object_type: string; title: string }>(
      `SELECT object_type, title FROM retrieval_objects WHERE space_id = $1 AND object_id = $2`,
      [SPACE, thread.id],
    );
    expect(indexed.rows[0]).toEqual({ object_type: "inquiry_thread", title: "Does caching reduce tail latency?" });

    await iterationSvc.recordIteration(identity(), PROJECT, thread.id as string, {
      change_summary: "Benchmarked",
      current_answer_summary: "Yes, p95 drops 40%",
      answer_state: "partial",
    });
    const revalidated = await inquiryRetrievalAdapter.revalidate(db.pool, SPACE, "inquiry_thread", thread.id as string, OWNER);
    expect(revalidated?.text).toContain("Yes, p95 drops 40%");
  });

  it("revalidate denies a viewer who is not a Project member, even though the row is indexed", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Private-ish question" });
    const asOwner = await inquiryRetrievalAdapter.revalidate(db.pool, SPACE, "inquiry_thread", thread.id as string, OWNER);
    expect(asOwner).not.toBeNull();
    const asOutsider = await inquiryRetrievalAdapter.revalidate(db.pool, SPACE, "inquiry_thread", thread.id as string, OUTSIDER);
    expect(asOutsider).toBeNull();
  });

  it("withholds Thread bodies from summary-only readers across retrieval and direct reads", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, OUTSIDER],
    );
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'viewer', 'active', now(), now())`,
      [randomUUID(), SPACE, PROJECT, OUTSIDER],
    );
    const thread = await new InquiryThreadService(db.pool).createThread(identity(), PROJECT, {
      kind: "question", statement: "Caching investigation",
    });
    await new InquiryIterationService(db.pool).recordIteration(identity(), PROJECT, thread.id as string, {
      change_summary: "Private measurements", current_answer_summary: "Confidential latency measurements",
      known_gaps: "Confidential customer impact", answer_state: "partial",
    });
    await db.pool.query(`UPDATE space_objects SET access_level = 'summary', summary = 'Public investigation overview' WHERE id = $1`, [thread.id]);
    expect(await inquiryRetrievalAdapter.revalidate(db.pool, SPACE, "inquiry_thread", thread.id as string, OUTSIDER))
      .toEqual({ title: "Caching investigation", text: "Public investigation overview" });
    const payloads: unknown[] = [];
    const search = new RetrievalSearchService(db.pool, inquiryRetrievalRegistry, { synthesizer: {
      synthesize: async (_space, _viewer, _query, candidates) => { payloads.push(candidates); return null; },
    } });
    const response = await search.buildBrief({ spaceId: SPACE, viewerUserId: OUTSIDER, query: "Caching investigation", mode: "exact" });
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify([response, payloads])).not.toContain("Confidential");
    expect(JSON.stringify(payloads)).toContain("Public investigation overview");
    expect((await inquiryRetrievalAdapter.revalidate(db.pool, SPACE, "inquiry_thread", thread.id as string, OWNER))?.text)
      .toContain("Confidential latency measurements");

    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, thread.id as string, {
      next_focus_kind: "synthesize", next_focus_note: "Confidential next action",
    });
    const threads = new InquiryThreadService(db.pool);
    const iterations = new InquiryIterationService(db.pool);
    const visible = await threads.getThread(outsiderIdentity(), PROJECT, thread.id as string);
    expect(visible.statement).toBe("Caching investigation");
    expect(visible.question_state).toBeNull();
    expect(JSON.stringify([visible, await threads.listThreads(outsiderIdentity(), PROJECT)]))
      .not.toContain("Confidential");
    for (const read of ["listIterations", "listRevisions", "listSteps", "listWorkEvents"] as const) {
      await expect(iterations[read](outsiderIdentity(), PROJECT, thread.id as string)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(await iterations.listOpenProjectSteps(outsiderIdentity(), PROJECT)).toEqual([]);
    const advice = new InquiryAdviceService(db.pool, { databaseUrl: "postgres://unused" } as ServerConfig);
    await expect(advice.getAdvice(outsiderIdentity(), PROJECT, thread.id as string))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await advice.getAdvice(identity(), PROJECT, thread.id as string)).toBeNull();
    expect((await threads.getThread(identity(), PROJECT, thread.id as string)).question_state)
      .toMatchObject({ current_answer_summary: "Confidential latency measurements" });
    await threads.setPersonalFocus(outsiderIdentity(), PROJECT, thread.id as string, true);
    const focused = await threads.listPersonalFocus(outsiderIdentity(), PROJECT);
    expect(focused).toHaveLength(1);
    expect(JSON.stringify(focused)).not.toContain("Confidential");

    const corpusItem = await createCorpusItem();
    await db.pool.query(`UPDATE space_objects SET visibility = 'space_shared'
      WHERE id = (SELECT object_id FROM project_corpus_items WHERE id = $1)`, [corpusItem]);
    const signals = new InquirySignalService(db.pool);
    const signal = await signals.createSignal(identity(), PROJECT, thread.id as string, {
      corpus_item_id: corpusItem, classification: "contradicts",
    });
    expect(await signals.listAllSignals(identity(), PROJECT)).toHaveLength(1);
    expect(await signals.listAllSignals(outsiderIdentity(), PROJECT)).toEqual([]);
    expect(await signals.listCandidates(outsiderIdentity(), PROJECT)).toEqual([]);
    await expect(signals.getCandidate(outsiderIdentity(), PROJECT, signal.candidate_id as string))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("drops a superseded Thread from the read plane", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Original" });
    await iterationSvc.reviseDefinition(identity(), PROJECT, thread.id as string, {
      revision_kind: "semantic_change",
      new_statement: "Completely different",
      structure_action: "supersede",
    });
    const canonical = await inquiryRetrievalAdapter.loadCanonical(db.pool, SPACE, "inquiry_thread", thread.id as string);
    expect(canonical).toBeNull();
  });

  it("produces an Inquiry graph with working-tier edges, and a Combined graph that still includes it", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const question = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Root question" });
    const hypothesis = await threadSvc.createThread(identity(), PROJECT, { kind: "hypothesis", statement: "A proposed answer" });
    await threadSvc.addRelation(identity(), PROJECT, {
      from_thread_id: question.id,
      to_thread_id: hypothesis.id,
      relation_kind: "proposes",
    });

    const graphSvc = new InquiryGraphService(db.pool);
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

  it("reports the requested node limit on an Inquiry graph, even with no Threads", async () => {
    if (!db.available) return;
    const graph = await new InquiryGraphService(db.pool).getInquiryGraph(identity(), PROJECT, { limit: 50 });
    expect(graph.nodes).toHaveLength(0);
    // `view.limit` is the request's bound, as every other producer reports it,
    // and the protocol requires it positive.
    expect(graph.view.limit).toBe(50);
  });

  it("applies the requested node limit across the whole Combined graph", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "First" });
    await threadSvc.createThread(identity(), PROJECT, { kind: "hypothesis", statement: "Second" });
    await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Third" });

    const graph = await new InquiryGraphService(db.pool).getCombinedProjectGraph(
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
    const thread = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: "Will be superseded" });
    await iterationSvc.reviseDefinition(identity(), PROJECT, thread.id as string, {
      revision_kind: "semantic_change",
      new_statement: "Replacement",
      structure_action: "supersede",
    });
    const graph = await new InquiryGraphService(db.pool).getInquiryGraph(identity(), PROJECT);
    expect(graph.nodes.some((n) => n.id === thread.id)).toBe(false);
    expect(graph.nodes.some((n) => n.label === "Replacement")).toBe(true);
  });

  it("keeps the Inquiry graph Space- and membership-gated", async () => {
    if (!db.available) return;
    const graphSvc = new InquiryGraphService(db.pool);
    await expect(graphSvc.getInquiryGraph(outsiderIdentity(), PROJECT)).rejects.toMatchObject({ statusCode: 404 });
  });
});
