import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { loadConfig } from "../src/config";
import { writeNote } from "../src/modules/knowledge/noteRevisionService";
import { PgProposalApplyService } from "../src/modules/proposals/applyService";
import { KnowledgePromotionCandidateService } from "../src/modules/knowledgePromotion/candidateService";
import { canonicalRunOutput } from "../src/modules/runs/orchestrationResults";
import { KnowledgeExtractionService } from "../src/modules/knowledgePromotion/extractionService";
import { ProjectReviewSessionService } from "../src/modules/projectReview/service";
import { processUnclaimedDomainChangeEvents } from "../src/modules/knowledgePromotion/revalidationService";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService";
import { ExperimentDefinitionService } from "../src/modules/experiments/definitionService";
import { ExperimentRunService } from "../src/modules/experiments/runService";
import { ExperimentInterpretationService } from "../src/modules/experiments/interpretationService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for Knowledge promotion and revalidation:
// discriminated pinned source references, the domain_change_outbox
// transport table, idempotent revalidation outcomes, and proposal-gated
// promotion. Completion-gate invariants under direct test:
//   - accepted Knowledge resolves to its exact source revision;
//   - later Note edits never overwrite Knowledge;
//   - material changes create reviewable revalidation;
//   - irrelevant edits produce a no-impact record without review noise.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const AGENT = "99999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";
const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

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
    console.warn(`[knowledge-promotion-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE knowledge_revalidation_outcomes, knowledge_promotion_candidates, knowledge_promotion_review_packets, domain_change_outbox,
       inquiry_thread_revisions, note_revisions, notes, note_collections, knowledge_items, space_objects,
       proposals, experiment_interpretations, experiment_observations, experiment_runs, experiment_versions,
       experiment_definitions, inquiry_threads, projects, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,created_at,updated_at)
     VALUES ($1,$2,$3,'Extraction Agent','active',NULL,'private',$4,$4)`,
    [AGENT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id,agent_id,space_id,version_label,system_prompt,model_config_json,runtime_config_json,
       context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,runtime_policy_json,created_at
     ) VALUES ($1,$2,$3,'v1','Extract governed candidates.','{}','{}','{}','{}','[]','{}','{}',$4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, AGENT_VERSION]);
});

function doc(paragraphs: string[]): Record<string, unknown> {
  return { type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) };
}

async function seedNote(initialParagraphs: string[]): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, status, visibility, owner_user_id, primary_project_id, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'note','Test note','active','space_shared',$3,$4,$3,$5,$5)`,
    [objectId, SPACE, OWNER, PROJECT, now],
  );
  await pool!.query(
    `INSERT INTO notes (object_id,space_id,content_json,content_format,content_schema_version,plain_text,version,content_hash,refs_json)
     VALUES ($1,$2,$3::jsonb,'prosemirror_json',1,$4,1,'seed','[]'::jsonb)`,
    [objectId, SPACE, JSON.stringify(doc(initialParagraphs)), initialParagraphs.join("\n\n")],
  );
  const { insertInitialNoteRevision } = await import("../src/modules/knowledge/noteRevisionService.js");
  await insertInitialNoteRevision(pool!, { spaceId: SPACE, noteId: objectId, doc: doc(initialParagraphs), at: now });
  return objectId;
}

function proposalApplyService() {
  const config = loadConfig({ SERVER_DATABASE_URL: container!.getConnectionUri(), SERVER_INTERNAL_TOKEN: "test-internal-token" });
  return PgProposalApplyService.fromConfig(config);
}

describe("Knowledge promotion and revalidation (real Postgres)", () => {
  it("queues AI extraction against an immutable source and reconciles only reviewable Candidates idempotently", async () => {
    if (!available || !pool) return;
    const noteId = await seedNote(["A durable finding worth reviewing."]);
    const extraction = new KnowledgeExtractionService(pool);
    const queued = await extraction.queue(identity, PROJECT, {
      source_kind: "note",
      source_id: noteId,
      agent_id: AGENT,
    });
    const runId = queued.run_id as string;
    const run = await pool.query<{ status: string; workflow_input: Record<string, unknown> }>(
      `SELECT status,contract_snapshot_json->'workflow_input_json' AS workflow_input
         FROM runs WHERE id=$1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "queued",
      workflow_input: {
        kind: "knowledge_candidate_extraction",
        source_kind: "note",
        source_id: noteId,
      },
    });
    expect((run.rows[0]!.workflow_input.source_ref as Record<string, unknown>)).toMatchObject({
      kind: "note_revision",
      note_id: noteId,
      version: 1,
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1`,
      [runId],
    )).rows[0]!.count).toBe(1);

    await pool.query(
      `UPDATE runs SET status='succeeded',output_json=$2::jsonb,ended_at=$3,updated_at=$3 WHERE id=$1`,
      [runId, JSON.stringify(canonicalRunOutput({
        success: true,
        outputText: "",
        outputJson: {
          knowledge_candidates: [{
            candidate_kind: "lesson",
            proposed_title: "Durable finding",
            proposed_content: "A durable finding worth reviewing.",
          }],
        },
      })), new Date().toISOString()],
    );
    expect(await extraction.reconcile(SPACE, runId)).toBe(1);
    expect(await extraction.reconcile(SPACE, runId)).toBe(1);
    const stored = await pool.query<{
      status: string; source_ref_json: Record<string, unknown>; proposed_title: string;
    }>(
      `SELECT status,source_ref_json,proposed_title
         FROM knowledge_promotion_candidates WHERE source_ref_json->>'extraction_run_id'=$1`,
      [runId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ status: "pending", proposed_title: "Durable finding" });
    expect(stored.rows[0]!.source_ref_json).toMatchObject({
      kind: "note_revision",
      note_id: noteId,
      version: 1,
      extraction_run_id: runId,
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM knowledge_items`,
    )).rows[0]!.count).toBe(0);

    const review = await new ProjectReviewSessionService(pool).open(identity, PROJECT, 5);
    expect(review.summary).toBe("0 Inquiry changes and 1 Knowledge change need review.");
    const sections = review.sections as {
      inquiry: { packet: { candidates: unknown[] } };
      knowledge: { packet: { candidates: unknown[] } };
    };
    expect(sections.inquiry.packet.candidates).toHaveLength(0);
    expect(sections.knowledge.packet.candidates).toHaveLength(1);
  });

  it("promotes a Note-block Candidate; a same-block edit revalidates, a different-block edit is no_impact, and the original Knowledge version is never overwritten", async () => {
    if (!available || !pool || !container) return;
    const noteId = await seedNote(["Block zero: unrelated context.", "Block one: the finding that matters."]);

    const candidates = new KnowledgePromotionCandidateService(pool);
    const candidate = await candidates.createFromNote(identity, PROJECT, {
      note_id: noteId, block_anchors: [1], candidate_kind: "concept",
      proposed_title: "The finding that matters", proposed_content: "Block one: the finding that matters.",
    });
    expect(candidate).toMatchObject({ trigger: "promotion", status: "pending", source_kind: "note" });
    const pinnedRef = candidate.source_ref as { kind: string; note_id: string; version: number; block_anchors: number[] };
    expect(pinnedRef).toMatchObject({ kind: "note_revision", note_id: noteId, version: 1, block_anchors: [1] });

    const promoted = await candidates.decideCandidate(identity, PROJECT, candidate.id as string, { decision: "promote" });
    expect(promoted.status).toBe("promoted");
    expect(promoted.created_proposal_id).toBeTruthy();

    const applied = await proposalApplyService().accept(promoted.created_proposal_id as string, identity);
    expect(applied?.proposal.status).toBe("accepted");
    const knowledgeItemId = (applied!.result as { knowledge_item: { id: string } }).knowledge_item.id;
    const stored = await pool.query<{ pinned_source_ref_json: unknown; content: string }>(
      `SELECT pinned_source_ref_json, content FROM knowledge_items WHERE object_id=$1 AND space_id=$2`,
      [knowledgeItemId, SPACE],
    );
    expect(stored.rows[0]!.pinned_source_ref_json).toEqual(pinnedRef);
    expect(stored.rows[0]!.content).toBe("Block one: the finding that matters.");

    // Edit block 0 only (the anchored block 1 is untouched) — irrelevant.
    await writeNote(pool, {
      spaceId: SPACE, noteId, expectVersion: 1,
      content: { kind: "doc", doc: doc(["Block zero: revised unrelated context.", "Block one: the finding that matters."]) },
      source: "user_edit",
    });
    let sweep = await processUnclaimedDomainChangeEvents(pool, SPACE);
    expect(sweep.outcomes).toMatchObject({ no_impact: 1 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM knowledge_promotion_candidates WHERE trigger='revalidation'`)).rows[0].n).toBe(0);
    const unchangedContent = await pool.query<{ content: string }>(`SELECT content FROM knowledge_items WHERE object_id=$1`, [knowledgeItemId]);
    expect(unchangedContent.rows[0]!.content).toBe("Block one: the finding that matters."); // later Note edits never overwrite Knowledge

    // Edit the anchored block itself — material, must produce a reviewable revalidation Candidate.
    await writeNote(pool, {
      spaceId: SPACE, noteId, expectVersion: 2,
      content: { kind: "doc", doc: doc(["Block zero: revised unrelated context.", "Block one: the finding now reads differently."]) },
      source: "user_edit",
    });
    sweep = await processUnclaimedDomainChangeEvents(pool, SPACE);
    expect(sweep.outcomes).toMatchObject({ candidate_created: 1 });
    const revalidationCandidateRow = await pool.query<{ id: string; trigger: string; supersedes_knowledge_item_id: string; proposed_content: string }>(
      `SELECT id, trigger, supersedes_knowledge_item_id, proposed_content FROM knowledge_promotion_candidates WHERE trigger='revalidation'`,
    );
    expect(revalidationCandidateRow.rows[0]).toMatchObject({
      trigger: "revalidation",
      supersedes_knowledge_item_id: knowledgeItemId,
      proposed_content: "Block one: the finding now reads differently.",
    });

    // Idempotency: re-running the sweep must not double-count or duplicate outcomes for events already processed.
    const secondSweep = await processUnclaimedDomainChangeEvents(pool, SPACE);
    expect(secondSweep.processed).toBe(0);
    const outcomeCount = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM knowledge_revalidation_outcomes`);
    expect(outcomeCount.rows[0]!.n).toBe(2); // one no_impact, one candidate_created — never re-recorded

    // Accepting the revalidation Candidate creates a NEW Knowledge version (supersedes), never mutating the original.
    const revalidationPromoted = await candidates.decideCandidate(identity, PROJECT, revalidationCandidateRow.rows[0]!.id, { decision: "promote" });
    const revalidationApplied = await proposalApplyService().accept(revalidationPromoted.created_proposal_id as string, identity);
    expect(revalidationApplied?.proposal.status).toBe("accepted");
    const original = await pool.query<{ status: string; content: string }>(
      `SELECT so.status, ki.content FROM knowledge_items ki JOIN space_objects so ON so.id=ki.object_id WHERE ki.object_id=$1`,
      [knowledgeItemId],
    );
    expect(original.rows[0]).toMatchObject({ status: "superseded", content: "Block one: the finding that matters." });
    const replacement = await pool.query<{ content: string }>(
      `SELECT content FROM knowledge_items WHERE supersedes_item_id=$1`, [knowledgeItemId],
    );
    expect(replacement.rows[0]?.content).toBe("Block one: the finding now reads differently.");
  });

  it("promotes a Knowledge Candidate from an Inquiry Thread revision, keyed to a material Iteration", async () => {
    if (!available || !pool || !container) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const hypothesis = await threadSvc.createThread(identity, PROJECT, { kind: "hypothesis", statement: "Caching reduces latency" });
    const initialRevision = await pool.query<{ version: number; state_snapshot_json: Record<string, unknown> }>(
      `SELECT version, state_snapshot_json FROM inquiry_thread_revisions WHERE thread_id=$1 AND version=1`,
      [hypothesis.id],
    );
    expect(initialRevision.rows[0]).toMatchObject({
      version: 1,
      state_snapshot_json: { evaluation_state: "untested", proposed_claim: null },
    });
    await iterationSvc.recordIteration(identity, PROJECT, hypothesis.id as string, {
      change_summary: "Confirmed via benchmark", evaluation_state: "supported", confidence: 80,
    });
    const revisions = await pool.query<{ version: number; change_significance: string }>(
      `SELECT version, change_significance FROM inquiry_thread_revisions WHERE thread_id=$1 ORDER BY version DESC`,
      [hypothesis.id],
    );
    expect(revisions.rows[0]).toMatchObject({ change_significance: "material" });

    const candidates = new KnowledgePromotionCandidateService(pool);
    const candidate = await candidates.createFromThread(identity, PROJECT, {
      thread_id: hypothesis.id, candidate_kind: "lesson",
      proposed_title: "Caching reduces latency (confirmed)", proposed_content: "Benchmarked and confirmed: caching reduces latency.",
    });
    const promoted = await candidates.decideCandidate(identity, PROJECT, candidate.id as string, { decision: "promote" });
    const applied = await proposalApplyService().accept(promoted.created_proposal_id as string, identity);
    expect(applied?.proposal.status).toBe("accepted");
    const knowledgeItemId = (applied!.result as { knowledge_item: { id: string } }).knowledge_item.id;
    const stored = await pool.query<{ pinned_source_ref_json: { kind: string; thread_id: string } }>(
      `SELECT pinned_source_ref_json FROM knowledge_items WHERE object_id=$1`, [knowledgeItemId],
    );
    expect(stored.rows[0]!.pinned_source_ref_json).toMatchObject({ kind: "inquiry_thread_revision", thread_id: hypothesis.id });
  });

  it("promotes a Knowledge Candidate from a converted Experiment Interpretation only, never a draft one", async () => {
    if (!available || !pool || !container) return;
    const definitions = new ExperimentDefinitionService(pool);
    const runs = new ExperimentRunService(pool);
    const interpretations = new ExperimentInterpretationService(pool);
    const threadSvc = new InquiryThreadService(pool);
    const hypothesis = await threadSvc.createThread(identity, PROJECT, { kind: "hypothesis", statement: "Warm cache improves p95" });
    const definition = await definitions.createDefinition(identity, PROJECT, { name: "Cache experiment", primary_hypothesis_thread_id: hypothesis.id });
    const version = await definitions.createVersion(identity, PROJECT, definition.id as string, { executor_type: "manual" });
    await definitions.approveVersion(identity, PROJECT, definition.id as string, version.id as string);
    const run = await runs.createRun(identity, PROJECT, definition.id as string, version.id as string, { is_baseline: true });
    await runs.completeRun(identity, PROJECT, definition.id as string, run.id as string, { status: "completed" });
    const interpretation = await interpretations.createInterpretation(identity, PROJECT, definition.id as string, {
      run_ids: [run.id], verdict: "supports", conclusion: "Warm cache confirmed to improve p95.",
    });

    const candidates = new KnowledgePromotionCandidateService(pool);
    await expect(candidates.createFromInterpretation(identity, PROJECT, {
      interpretation_id: interpretation.id, candidate_kind: "lesson", proposed_title: "x", proposed_content: "y",
    })).rejects.toMatchObject({ statusCode: 409 });

    await interpretations.markReviewed(identity, PROJECT, interpretation.id as string);
    await interpretations.convertToSignal(identity, PROJECT, interpretation.id as string, {});
    const candidate = await candidates.createFromInterpretation(identity, PROJECT, {
      interpretation_id: interpretation.id, candidate_kind: "lesson",
      proposed_title: "Warm cache improves p95", proposed_content: "Warm cache confirmed to improve p95.",
    });
    expect(candidate.source_ref).toMatchObject({ kind: "experiment_interpretation", interpretation_id: interpretation.id, definition_id: definition.id });
    const promoted = await candidates.decideCandidate(identity, PROJECT, candidate.id as string, { decision: "promote" });
    const applied = await proposalApplyService().accept(promoted.created_proposal_id as string, identity);
    expect(applied?.proposal.status).toBe("accepted");
  });

  it("records failed revalidation attempts and leaves the event eligible for a later retry", async () => {
    if (!available || !pool || !container) return;
    const noteId = await seedNote(["Pinned block."]);
    const candidates = new KnowledgePromotionCandidateService(pool);
    const candidate = await candidates.createFromNote(identity, PROJECT, {
      note_id: noteId, block_anchors: [0], candidate_kind: "summary",
      proposed_title: "Pinned block", proposed_content: "Pinned block.",
    });
    const promoted = await candidates.decideCandidate(identity, PROJECT, candidate.id as string, { decision: "promote" });
    await proposalApplyService().accept(promoted.created_proposal_id as string, identity);

    const eventId = randomUUID();
    const missingRevisionId = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO domain_change_outbox (
         id, space_id, source_kind, source_id, source_ref_json, change_kind,
         change_significance, occurred_at
       ) VALUES ($1,$2,'note',$3,$4::jsonb,'revision_created',NULL,$5)`,
      [eventId, SPACE, noteId, JSON.stringify({
        kind: "note_revision", note_id: noteId, revision_id: missingRevisionId,
        version: 2, content_hash: "missing", block_anchors: [],
      }), now],
    );

    await processUnclaimedDomainChangeEvents(pool, SPACE);
    const failed = await pool.query<{
      processed_at: string | null;
      attempt_count: number;
      last_error: string | null;
      claim_expires_at: string | null;
    }>(
      `SELECT processed_at, attempt_count, last_error, claim_expires_at
         FROM domain_change_outbox WHERE id=$1`,
      [eventId],
    );
    expect(failed.rows[0]).toMatchObject({ processed_at: null, attempt_count: 1 });
    expect(failed.rows[0]!.last_error).toContain(missingRevisionId);
    expect(failed.rows[0]!.claim_expires_at).toBeTruthy();
  });

  it("dismisses a Candidate without creating a proposal", async () => {
    if (!available || !pool) return;
    const noteId = await seedNote(["Only block."]);
    const candidates = new KnowledgePromotionCandidateService(pool);
    const candidate = await candidates.createFromNote(identity, PROJECT, {
      note_id: noteId, block_anchors: [0], candidate_kind: "summary", proposed_title: "t", proposed_content: "c",
    });
    const dismissed = await candidates.decideCandidate(identity, PROJECT, candidate.id as string, { decision: "dismiss" });
    expect(dismissed).toMatchObject({ status: "dismissed", created_proposal_id: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM proposals`)).rows[0].n).toBe(0);
  });

  it("opens bounded review packets while preserving a view-all list and defer/reopen flow", async () => {
    if (!available || !pool) return;
    const noteId = await seedNote(["Only block."]);
    const candidates = new KnowledgePromotionCandidateService(pool);
    for (let index = 0; index < 12; index += 1) {
      await candidates.createFromNote(identity, PROJECT, {
        note_id: noteId, block_anchors: [0], candidate_kind: "summary",
        proposed_title: `Candidate ${index}`, proposed_content: `Content ${index}`,
      });
    }
    const packet = await candidates.openReviewPacket(identity, PROJECT, 10) as { id: string; candidates: unknown[] };
    expect(packet.candidates).toHaveLength(10);
    expect(await candidates.listCandidates(identity, PROJECT, "pending")).toHaveLength(12);
    const first = packet.candidates[0] as { id: string };
    const deferred = await candidates.decideCandidate(identity, PROJECT, first.id, { decision: "defer" });
    expect(deferred.status).toBe("deferred");
    expect((await candidates.reopenCandidate(identity, PROJECT, first.id)).status).toBe("pending");
    await candidates.closeReviewPacket(identity, PROJECT, packet.id);
  });
});
