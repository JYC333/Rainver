import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService";
import { InquirySignalService } from "../src/modules/inquiry/signalService";

// Real-Postgres coverage for the Signals/Candidates/Review/Delta
// vertical slice. See plan section 10.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[inquiry-signal-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let PROJECT: string;
let THREAD: string;

const identity = () => ({ spaceId: SPACE, userId: OWNER });

async function createCorpusItem(visibility: "private" | "space_shared" = "private"): Promise<string> {
  const objectId = randomUUID();
  const corpusItemId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'source', 'A source', $3, $4, $5, $5)`,
    [objectId, SPACE, visibility, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO project_corpus_items (id, space_id, project_id, object_id, role, status, triage_status, read_status, metadata_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'candidate', 'active', 'new', 'unread', '{}'::jsonb, $5, $5)`,
    [corpusItemId, SPACE, PROJECT, objectId, now],
  );
  return corpusItemId;
}

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE inquiry_thread_advice, jobs, inquiry_delta_briefs, inquiry_signal_candidates, inquiry_evidence_signals, inquiry_review_packets, inquiry_thread_work_events, inquiry_iterations, inquiry_thread_statement_revisions, inquiry_thread_personal_focus, inquiry_question_states, inquiry_hypothesis_states, inquiry_threads, inquiry_project_settings, project_corpus_items, space_objects, projects, space_memberships, users, spaces CASCADE",
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', $3, $3), ($2, 'Member', 'active', $3, $3)`,
    [OWNER, MEMBER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  const project = await new PgProjectRepository(pool).create(identity(), { name: "Signals Project" });
  PROJECT = project.id as string;
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
    [randomUUID(), SPACE, MEMBER, now],
  );
  await pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'member', 'active', $5, $5)`,
    [randomUUID(), SPACE, PROJECT, MEMBER, now],
  );
  const thread = await new InquiryThreadService(pool).createThread(identity(), PROJECT, { kind: "hypothesis", statement: "Caching reduces latency", proposed_claim: "Cache hit rate above 80% halves p95 latency" });
  THREAD = thread.id as string;
});

describe("Inquiry Signals, Candidates, Review, and Delta (real Postgres)", () => {
  it("a batch of routine supporting Signals auto-attaches without creating review noise", async () => {
    if (!available || !pool) return;
    const signalSvc = new InquirySignalService(pool);
    for (let i = 0; i < 3; i += 1) {
      const corpusItemId = await createCorpusItem();
      const signal = await signalSvc.createSignal(identity(), PROJECT, THREAD, {
        corpus_item_id: corpusItemId,
        classification: "supports",
        confidence: 0.8,
        model_version: "classifier-v1",
      });
      expect(signal.status).toBe("auto_attached");
      expect(signal.candidate_id).toBeNull();
    }
    const candidates = await signalSvc.listCandidates(identity(), PROJECT);
    expect(candidates).toHaveLength(0);
    const allSignals = await signalSvc.listAllSignals(identity(), PROJECT);
    expect(allSignals).toHaveLength(3); // still fully audit-visible
  });

  it("multiple contradiction Signals about the same Thread consolidate into exactly one explainable Candidate", async () => {
    if (!available || !pool) return;
    const signalSvc = new InquirySignalService(pool);
    const signalIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const corpusItemId = await createCorpusItem();
      const signal = await signalSvc.createSignal(identity(), PROJECT, THREAD, {
        corpus_item_id: corpusItemId,
        classification: "contradicts",
        semantic_key: "same-cache-contradiction",
        confidence: 0.6,
        model_version: "classifier-v1",
      });
      expect(signal.status).toBe("consolidated");
      signalIds.push(signal.id as string);
    }
    const candidates = await signalSvc.listCandidates(identity(), PROJECT, "pending");
    expect(candidates).toHaveLength(1);
    const candidate = await signalSvc.getCandidate(identity(), PROJECT, candidates[0]!.id as string);
    expect((candidate.signals as unknown[])).toHaveLength(3);
    expect(candidate.candidate_kind).toBe("contradiction");
  });

  it("confirming (accepting) a Candidate creates an Inquiry Iteration, and dismissing one never removes its Signal audit record", async () => {
    if (!available || !pool) return;
    const signalSvc = new InquirySignalService(pool);
    const threadSvc = new InquiryThreadService(pool);
    const corpusItemId = await createCorpusItem();
    const signal = await signalSvc.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: corpusItemId,
      classification: "contradicts",
      confidence: 0.7,
    });
    const candidateId = signal.candidate_id as string;

    const accepted = await signalSvc.decideCandidate(identity(), PROJECT, candidateId, {
      decision: "accept",
      change_summary: "Contradicting evidence confirmed",
      evaluation_state: "challenged",
      confidence: 40,
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.resulting_iteration_id).toBeTruthy();

    const iterations = await new InquiryIterationService(pool).listIterations(identity(), PROJECT, THREAD);
    expect(iterations).toHaveLength(1);
    expect(iterations[0]!.id).toBe(accepted.resulting_iteration_id);

    const detail = await threadSvc.getThread(identity(), PROJECT, THREAD);
    expect(detail.hypothesis_state).toMatchObject({ evaluation_state: "challenged" });

    // A second, independent contradiction Candidate: dismiss it and confirm
    // the Signal audit record survives.
    const corpusItemId2 = await createCorpusItem();
    const signal2 = await signalSvc.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: corpusItemId2,
      classification: "contradicts",
    });
    const candidate2Id = signal2.candidate_id as string;
    const dismissed = await signalSvc.decideCandidate(identity(), PROJECT, candidate2Id, { decision: "dismiss" });
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.resulting_iteration_id).toBeNull();

    const stillAudited = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM inquiry_evidence_signals WHERE id = $1`,
      [signal2.id],
    );
    expect(stillAudited.rows[0]).toEqual({ id: signal2.id, status: "consolidated" });
    const allSignals = await signalSvc.listAllSignals(identity(), PROJECT);
    expect(allSignals.map((s) => s.id)).toContain(signal2.id);
  });

  it("rejects deciding an already-decided Candidate", async () => {
    if (!available || !pool) return;
    const signalSvc = new InquirySignalService(pool);
    const corpusItemId = await createCorpusItem();
    const signal = await signalSvc.createSignal(identity(), PROJECT, THREAD, { corpus_item_id: corpusItemId, classification: "raises_gap" });
    const candidateId = signal.candidate_id as string;
    await signalSvc.decideCandidate(identity(), PROJECT, candidateId, {
      decision: "gap",
      gap_statement: "What evidence would close this gap?",
    });
    await expect(signalSvc.decideCandidate(identity(), PROJECT, candidateId, { decision: "dismiss" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("bounds a Review Packet to the configured size and returns leftover Candidates to the pool on close", async () => {
    if (!available || !pool) return;
    const signalSvc = new InquirySignalService(pool);
    const threadSvc = new InquiryThreadService(pool);
    for (let i = 0; i < 4; i += 1) {
      const t = await threadSvc.createThread(identity(), PROJECT, { kind: "question", statement: `Q${i}` });
      const corpusItemId = await createCorpusItem();
      await signalSvc.createSignal(identity(), PROJECT, t.id as string, { corpus_item_id: corpusItemId, classification: "raises_gap" });
    }
    const packet = await signalSvc.openReviewPacket(identity(), PROJECT, 2);
    expect((packet.candidates as unknown[])).toHaveLength(2);
    const remainingPending = await signalSvc.listCandidates(identity(), PROJECT, "pending");
    expect(remainingPending.filter((c) => c.review_packet_id === null)).toHaveLength(2);

    const replacement = await signalSvc.openReviewPacket(identity(), PROJECT, 2);
    expect((replacement.candidates as unknown[])).toHaveLength(2);
    const oldPacket = await pool.query<{ status: string }>(
      `SELECT status FROM inquiry_review_packets WHERE id=$1`,
      [packet.id],
    );
    expect(oldPacket.rows[0]?.status).toBe("closed");

    await signalSvc.closeReviewPacket(identity(), PROJECT, replacement.id as string);
    const afterClose = await signalSvc.listCandidates(identity(), PROJECT, "pending");
    expect(afterClose.every((c) => c.review_packet_id === null)).toBe(true);
  });

  it("generates a read-only Delta Brief that never mutates Thread state", async () => {
    if (!available || !pool) return;
    const signalSvc = new InquirySignalService(pool);
    const threadSvc = new InquiryThreadService(pool);
    const before = await threadSvc.getThread(identity(), PROJECT, THREAD);

    const corpusItemId = await createCorpusItem();
    await signalSvc.createSignal(identity(), PROJECT, THREAD, { corpus_item_id: corpusItemId, classification: "supports" });
    const corpusItemId2 = await createCorpusItem();
    await signalSvc.createSignal(identity(), PROJECT, THREAD, { corpus_item_id: corpusItemId2, classification: "contradicts" });

    const brief = await signalSvc.generateDeltaBrief(identity(), PROJECT, {});
    const content = brief.content as Record<string, unknown>;
    expect((content.reinforced_positions as unknown[]).length).toBe(1);
    expect((content.challenged_positions as unknown[]).length).toBe(1);
    expect(content.decisions_required).toBe(1);

    const after = await threadSvc.getThread(identity(), PROJECT, THREAD);
    expect(after.version).toBe(before.version);
    expect(after.hypothesis_state).toEqual(before.hypothesis_state);
  });

  it("deduplicates retry deliveries but keeps unrelated semantic changes separate", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    const corpusItemId = await createCorpusItem();
    const body = {
      corpus_item_id: corpusItemId,
      classification: "contradicts",
      producer_idempotency_key: "run-1:item-1",
      semantic_key: "latency-regression",
    };
    const first = await service.createSignal(identity(), PROJECT, THREAD, body);
    const retry = await service.createSignal(identity(), PROJECT, THREAD, body);
    expect(retry.id).toBe(first.id);

    const secondCorpus = await createCorpusItem();
    await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: secondCorpus,
      classification: "contradicts",
      semantic_key: "memory-regression",
    });
    expect(await service.listCandidates(identity(), PROJECT, "pending")).toHaveLength(2);
  });

  it("does not retire current advice when a material Signal delivery is replayed", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    await new InquiryIterationService(pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    const body = {
      corpus_item_id: await createCorpusItem(),
      classification: "contradicts",
      producer_idempotency_key: "replayed-material-signal",
    };
    const first = await service.createSignal(identity(), PROJECT, THREAD, body);
    const generatedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO inquiry_thread_advice
         (id, space_id, project_id, thread_id, recommended_focus_kind, rationale,
          cited_refs_json, thread_version, status, trigger_kind, model_version,
          generated_by_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'read_evidence','Review the contradiction','[]'::jsonb,
               2,'open','candidate_created',NULL,$5,$6,$6)`,
      [randomUUID(), SPACE, PROJECT, THREAD, OWNER, generatedAt],
    );

    const retry = await service.createSignal(identity(), PROJECT, THREAD, body);
    expect(retry.id).toBe(first.id);
    const advice = await pool.query<{ status: string; updated_at: Date }>(
      "SELECT status, updated_at FROM inquiry_thread_advice WHERE thread_id=$1",
      [THREAD],
    );
    expect(advice.rows[0]?.status).toBe("open");
    expect(advice.rows[0]?.updated_at.toISOString()).toBe(generatedAt);
    expect((await pool.query(
      "SELECT id FROM jobs WHERE job_type='inquiry_next_step_advice'",
    )).rows).toHaveLength(1);
  });

  it("keeps a Candidate hidden unless every contributing Signal is readable", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    const semanticKey = "mixed-visibility-change";
    await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: await createCorpusItem("space_shared"),
      classification: "contradicts",
      semantic_key: semanticKey,
    });
    const privateSignal = await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: await createCorpusItem("private"),
      classification: "contradicts",
      semantic_key: semanticKey,
    });
    const memberIdentity = { spaceId: SPACE, userId: MEMBER };
    expect(await service.listCandidates(memberIdentity, PROJECT, "pending")).toHaveLength(0);
    await expect(
      service.getCandidate(memberIdentity, PROJECT, privateSignal.candidate_id as string),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.decideCandidate(memberIdentity, PROJECT, privateSignal.candidate_id as string, { decision: "dismiss" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const readableSignal = await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: await createCorpusItem("space_shared"),
      classification: "raises_gap",
      semantic_key: "later-readable-change",
    });
    const packet = await service.openReviewPacket(memberIdentity, PROJECT, 1);
    expect((packet.candidates as Array<Record<string, unknown>>).map((candidate) => candidate.id))
      .toEqual([readableSignal.candidate_id]);
  });

  it("serializes concurrent producer retries and Candidate consolidation", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    const body = {
      corpus_item_id: await createCorpusItem(),
      classification: "contradicts",
      semantic_key: "concurrent-change",
      producer_idempotency_key: "run-concurrent:item-1",
    };
    const [first, retry] = await Promise.all([
      service.createSignal(identity(), PROJECT, THREAD, body),
      service.createSignal(identity(), PROJECT, THREAD, body),
    ]);
    expect(retry.id).toBe(first.id);
    expect(await service.listCandidates(identity(), PROJECT, "pending")).toHaveLength(1);
  });

  it("rejects Signal/accept writes to terminal Threads and cross-Thread Candidate merges", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    const pending = await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: await createCorpusItem(),
      classification: "contradicts",
      semantic_key: "terminal-change",
      proposed_change: { evaluation_state: "challenged" },
    });
    const otherThread = await new InquiryThreadService(pool).createThread(identity(), PROJECT, {
      kind: "hypothesis",
      statement: "A distinct hypothesis",
    });
    const other = await service.createSignal(identity(), PROJECT, otherThread.id as string, {
      corpus_item_id: await createCorpusItem(),
      classification: "contradicts",
      semantic_key: "other-thread-change",
    });
    await expect(
      service.decideCandidate(identity(), PROJECT, pending.candidate_id as string, {
        decision: "merge",
        target_candidate_id: other.candidate_id,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await new InquiryIterationService(pool).transitionLifecycle(identity(), PROJECT, THREAD, {
      lifecycle_status: "resolved",
    });
    await expect(
      service.createSignal(identity(), PROJECT, THREAD, {
        corpus_item_id: await createCorpusItem(),
        classification: "supports",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.decideCandidate(identity(), PROJECT, pending.candidate_id as string, {
        decision: "accept",
        evaluation_state: "challenged",
        change_summary: "Should not apply",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rolls back Candidate acceptance when the Iteration is invalid, and supports defer/reopen", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    const signal = await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: await createCorpusItem(),
      classification: "contradicts",
      proposed_change: {},
    });
    await expect(
      service.decideCandidate(identity(), PROJECT, signal.candidate_id as string, { decision: "accept" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const afterFailure = await service.getCandidate(identity(), PROJECT, signal.candidate_id as string);
    expect(afterFailure.status).toBe("pending");
    expect((await new InquiryIterationService(pool).listIterations(identity(), PROJECT, THREAD))).toHaveLength(0);

    const deferred = await service.decideCandidate(identity(), PROJECT, signal.candidate_id as string, {
      decision: "defer",
      reason: "Wait for replication",
      defer_until: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(deferred.status).toBe("deferred");
    expect((await service.reopenCandidate(identity(), PROJECT, signal.candidate_id as string)).status).toBe("pending");
  });

  it("a Delta Brief covers only its window, so the next one reports what is genuinely new", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);

    await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: await createCorpusItem(),
      classification: "supports",
    });
    const first = await service.generateDeltaBrief(identity(), PROJECT, {});
    const firstContent = first.content as Record<string, unknown>;
    expect((firstContent.reinforced_positions as unknown[]).length).toBe(1);

    // Everything after the first Brief's coverage end is what "new" means.
    await service.createSignal(identity(), PROJECT, THREAD, {
      corpus_item_id: await createCorpusItem(),
      classification: "contradicts",
    });
    const second = await service.generateDeltaBrief(identity(), PROJECT, {
      coverage_start: first.coverage_end as string,
    });
    const secondContent = second.content as Record<string, unknown>;
    expect((secondContent.challenged_positions as unknown[]).length).toBe(1);
    expect((secondContent.reinforced_positions as unknown[]).length).toBe(0);
    expect((secondContent.input_and_coverage_window as Record<string, unknown>).signal_count).toBe(1);
  });

  it("exposes the most recent Brief so a caller can continue from its coverage end", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    expect(await service.latestDeltaBrief(identity(), PROJECT)).toBeNull();

    await service.generateDeltaBrief(identity(), PROJECT, {});
    const newest = await service.generateDeltaBrief(identity(), PROJECT, {});

    const latest = await service.latestDeltaBrief(identity(), PROJECT);
    expect(latest?.id).toBe(newest.id);
    expect(latest?.coverage_end).toBe(newest.coverage_end);
  });

  it("keeps a Delta Brief inside its own Project and refuses a non-member", async () => {
    if (!available || !pool) return;
    const service = new InquirySignalService(pool);
    await service.generateDeltaBrief(identity(), PROJECT, {});

    const otherProject = await new PgProjectRepository(pool).create(identity(), { name: "Unrelated Project" });
    expect(await service.latestDeltaBrief(identity(), otherProject.id as string)).toBeNull();

    const stranger = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Stranger', 'active', $2, $2)`,
      [stranger, now],
    );
    await expect(
      service.latestDeltaBrief({ spaceId: SPACE, userId: stranger }, PROJECT),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) });
  });
});
