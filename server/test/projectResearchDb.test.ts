import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject, seedAgentWithVersion } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService";
import { resolveResearchThreadScope } from "../src/modules/projectResearch/threadScope";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for the Academic Research project-scoped research
// workflow/checkpoint/artifact-link/evidence-matrix/integrity API surface
// backing /api/v1/projects/:projectId/research/*.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const AGENT = "99999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";
const CONFIG = loadConfig({});


const db = useTestDatabase(__filename);

beforeAll(async () => {
  if (!db.available) return;
  registerProjectResearchExecutionHandlers();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_research_reports", "project_research_checkpoints", "project_research_workflows", "artifacts", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
});

function repo(): ProjectResearchRepository {
  return new ProjectResearchRepository(db.pool);
}

async function seedWorkflow(state: Record<string, unknown> = {}, primaryThreadId: string | null = null): Promise<string> {
  const workflowId = randomUUID();
  const now = new Date().toISOString();
  await insertResearchWorkflowFixture(db.pool, {
    id: workflowId, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    state, primaryThreadId, now,
  });
  return workflowId;
}

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

describe("ProjectResearchRepository (real Postgres)", () => {
  it("projects the canonical Inquiry owner needed by the research setup UI", async () => {
    if (!db.available) return;
    const thread = await new InquiryThreadService(db.pool).createThread(
      identity,
      PROJECT,
      { kind: "question", statement: "How should agents remember?" },
    );
    const workflowId = await seedWorkflow({
      question_refine_skipped: false,
      research_context_version_id: randomUUID(),
    }, String(thread.id));

    await expect(repo().listWorkflows(identity, PROJECT)).resolves.toContainEqual(expect.objectContaining({
      id: workflowId,
      primary_thread_id: String(thread.id),
      state_json: expect.objectContaining({ question_refine_skipped: false }),
    }));
  });

  it("materializes and reuses a normal Inquiry Question as the Auto Research scope", async () => {
    if (!db.available) return;
    const first = await resolveResearchThreadScope(db.pool, identity, PROJECT, "Which mechanism explains the effect?", null);
    const second = await resolveResearchThreadScope(db.pool, identity, PROJECT, "Which mechanism explains the effect?", null);
    expect(second).toEqual(first);
    expect((await db.pool.query<{ created_from: string }>(
      `SELECT created_from FROM inquiry_threads WHERE object_id=$1 AND space_id=$2`,
      [first.thread_id, SPACE],
    )).rows[0]?.created_from).toBe("user");
  });

  it("aggregates persisted monitoring scans into one entry per UTC day without synthesizing missing days", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow({ research_question: "Does X improve Y?" });
    const older = "2026-07-17T08:00:00.000Z";
    const newerMorning = "2026-07-18T08:00:00.000Z";
    const newerEvening = "2026-07-18T20:00:00.000Z";
    for (const [key, scannedAt, count] of [
      ["scan:older", older, 0],
      ["scan:newer-morning", newerMorning, 3],
      ["scan:newer-evening", newerEvening, 4],
    ] as const) {
      await db.pool.query(
        `INSERT INTO research_scan_summaries (
           id,space_id,project_id,workflow_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,2,1,4,$6)`,
        [randomUUID(), SPACE, PROJECT, workflowId, key, scannedAt, count],
      );
    }
    const scans = await repo().listScanSummaries(identity, PROJECT);
    expect(scans).toHaveLength(2);
    expect(scans[0]).toMatchObject({
      scan_date: "2026-07-18", scanned_at: newerEvening, new_item_count: 7, relevant_count: 4, scan_count: 2,
    });
    expect(scans[1]).toMatchObject({ scan_date: "2026-07-17", scanned_at: older, new_item_count: 0, scan_count: 1 });
  });

  it("records a successful zero-item scan and completes its waiting incremental operation", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow({ research_question: "Does X improve Y?" });
    await db.pool.query(
      `UPDATE project_research_workflows
          SET state_json=state_json || $3::jsonb
        WHERE space_id=$1 AND object_id=$2`,
      [SPACE, workflowId, JSON.stringify({ channel_ids: ["channel-1"], monitoring: { active: true } })],
    );
    const operationId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_operations (
         id,space_id,project_id,kind,title,status,created_by_user_id,progress_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'research','Incremental scan','active',$4,$5::jsonb,$6,$6)`,
      [operationId, SPACE, PROJECT, OWNER, JSON.stringify({
        schema_version: "project_research_operation.v1", run_kind: "incremental", workflow_id: workflowId,
        agent_id: AGENT,
        research_question: "Does X improve Y?", research_question_version: 1, channel_ids: ["channel-1"],
        source_item_ids: [], current_stage: "screening", stage_state: "running", awaiting_source_scan: true,
        watermark: { before: null, after: "2026-07-17T00:00:00.000Z", overlap_hours: 48 },
      }), now],
    );
    await new ProjectResearchOrchestrator(db.pool, CONFIG).onSourceScanCompleted({
      spaceId: SPACE, sourceChannelId: "channel-1", scanJobId: "scan-job-1",
      scannedAt: "2026-07-18T08:00:00.000Z", scanWindowStart: "2026-07-17T00:00:00.000Z",
      scanWindowEnd: "2026-07-18T00:00:00.000Z", newItemCount: 0,
    });
    const operation = await db.pool.query<{ status: string; progress_json: Record<string, unknown> }>(
      `SELECT status,progress_json FROM project_operations WHERE id=$1`, [operationId],
    );
    expect(operation.rows[0]?.status).toBe("completed");
    expect(operation.rows[0]?.progress_json).toMatchObject({
      current_stage: "complete",
      awaiting_source_scan: false,
      watermark: {
        before: "2026-07-17T00:00:00.000Z",
        after: "2026-07-18T00:00:00.000Z",
      },
    });
    const scans = await repo().listScanSummaries(identity, PROJECT);
    expect(scans).toHaveLength(1);
    // scan_date reflects when the scan actually ran (now), not the
    // publication-date watermark ("2026-07-17") the operation carried.
    const todayUtc = new Date().toISOString().slice(0, 10);
    expect(scans[0]).toMatchObject({ scan_date: todayUtc, new_item_count: 0, relevant_count: 0, scan_count: 1 });
  });

  it("collapses repeated same-day zero-result scans into one refreshed daily row", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow({ research_question: "Does X improve Y?" });
    await db.pool.query(
      `UPDATE project_research_workflows
          SET state_json=state_json || $3::jsonb
        WHERE space_id=$1 AND object_id=$2`,
      [SPACE, workflowId, JSON.stringify({ channel_ids: ["channel-1"], monitoring: { active: true } })],
    );
    for (const [jobId, scannedAt] of [["scan-job-a", "2026-07-18T08:00:00.000Z"], ["scan-job-b", "2026-07-18T20:00:00.000Z"]] as const) {
      await new ProjectResearchOrchestrator(db.pool, CONFIG).onSourceScanCompleted({
        spaceId: SPACE, sourceChannelId: "channel-1", scanJobId: jobId,
        scannedAt, scanWindowStart: "2026-07-17T00:00:00.000Z",
        scanWindowEnd: "2026-07-18T00:00:00.000Z", newItemCount: 0,
      });
    }
    const rows = await db.pool.query<{ scanned_at: string }>(
      `SELECT scanned_at FROM research_scan_summaries WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    );
    expect(rows.rows).toHaveLength(1);
    const scans = await repo().listScanSummaries(identity, PROJECT);
    expect(scans[0]).toMatchObject({ scan_date: "2026-07-18", scanned_at: "2026-07-18T20:00:00.000Z", scan_count: 1 });
  });

  it("activates monitoring even when the workflow state has no monitoring object yet", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow({ research_question: "Does X improve Y?" });
    // Reused workflows created by the draft/item-limit paths carry a minimal
    // state without a `monitoring` key; jsonb_set cannot create it.
    await db.pool.query(
      `UPDATE project_research_workflows SET state_json='{"schema_version":"project_research_initial_intake.v1"}'::jsonb WHERE space_id=$1 AND object_id=$2`,
      [SPACE, workflowId],
    );
    const orchestrator = new ProjectResearchOrchestrator(db.pool, CONFIG) as unknown as {
      setWorkflowMonitoring(spaceId: string, projectId: string, workflowId: string, state: {
        channel_ids: string[];
        source_post_processing_rule_ids: string[];
        watermark: { before: string | null; after: string | null; overlap_hours: number };
      }): Promise<void>;
    };
    await orchestrator.setWorkflowMonitoring(SPACE, PROJECT, workflowId, {
      channel_ids: [],
      source_post_processing_rule_ids: [],
      watermark: { before: null, after: null, overlap_hours: 48 },
    });
    const updated = await db.pool.query<{ state_json: Record<string, unknown> }>(
      `SELECT state_json FROM project_research_workflows WHERE space_id=$1 AND object_id=$2`,
      [SPACE, workflowId],
    );
    expect(updated.rows[0]?.state_json).toMatchObject({ monitoring: { active: true, channel_ids: [] } });
  });

  it("blocks incremental research until a changed project question is explicitly applied forward", async () => {
    if (!db.available) return;
    const workflowId = randomUUID();
    const now = new Date().toISOString();
    const thread = await new InquiryThreadService(db.pool).createThread(
      identity,
      PROJECT,
      { kind: "question", statement: "Old research question" },
    );
    await insertResearchWorkflowFixture(db.pool, {
      id: workflowId, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
      currentStage: "screening", primaryThreadId: String(thread.id), state: {
          research_question: "Old research question",
          thread_scope: [{ thread_id: thread.id, version: thread.version, kind: "question", statement: thread.statement }],
          channel_ids: [],
          project_source_binding_ids: [],
          monitoring: { active: true },
        }, now,
    });
    await new InquiryIterationService(db.pool).reviseDefinition(identity, PROJECT, thread.id as string, {
      revision_kind: "wording_only",
      new_statement: "New research question",
    });

    const orchestrator = new ProjectResearchOrchestrator(db.pool, CONFIG);
    await expect(orchestrator.triggerIncremental(identity, PROJECT, workflowId, {})).rejects.toMatchObject({ statusCode: 409 });

    const applied = await orchestrator.applyQuestionForward(identity, PROJECT, workflowId);
    expect(applied).toMatchObject({ id: workflowId, state_json: { research_question: "New research question" } });
    expect(applied.state_json).toMatchObject({
      previous_research_question: "Old research question",
      question_change_mode: "apply_forward",
      research_question_version: 2,
      previous_research_question_version: 1,
    });
    const stored = await db.pool.query<{ state_json: Record<string, unknown> }>(
      `SELECT state_json FROM project_research_workflows WHERE space_id=$1 AND object_id=$2`,
      [SPACE, workflowId],
    );
    expect(stored.rows[0]?.state_json).toMatchObject({ research_question: "New research question" });
  });

  it("starts a versioned re-screen while preserving human-confirmed triage", async () => {
    if (!db.available) return;
    const workflowId = randomUUID();
    const humanItemId = randomUUID();
    const aiItemId = randomUUID();
    const now = new Date().toISOString();
    const thread = await new InquiryThreadService(db.pool).createThread(
      identity,
      PROJECT,
      { kind: "question", statement: "Old question" },
    );
    await insertResearchWorkflowFixture(db.pool, {
      id: workflowId, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
      currentStage: "complete", primaryThreadId: String(thread.id), state: {
        research_question: "Old question", research_question_version: 1, channel_ids: [],
        thread_scope: [{ thread_id: thread.id, version: thread.version, kind: "question", statement: thread.statement }],
        report_depth: "full", question_refine_skipped: false,
        source_post_processing_rule_ids: [], monitoring: { active: true },
      }, now,
    });
    await new InquiryIterationService(db.pool).reviseDefinition(identity, PROJECT, thread.id as string, {
      revision_kind: "wording_only",
      new_statement: "New question",
    });
    for (const itemId of [humanItemId, aiItemId]) {
      await db.pool.query(
        `INSERT INTO source_items (
           id, space_id, owner_user_id, visibility, item_type, title, first_seen_at, last_seen_at,
           content_state, retention_policy, created_at, updated_at
         ) VALUES ($1,$2,$3,'space_shared','external_url',$1,$4,$4,'excerpt_saved','summary_only',$4,$4)`,
        [itemId, SPACE, OWNER, now],
      );
    }
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, source_item_id, role, status, triage_status,
         triage_confirmed_by_user, relevance, confidence, reason, metadata_json, created_at, updated_at
       ) VALUES
         ($1,$2,$3,$4,'candidate','active','included',true,'relevant',0.9,'human decision','{}'::jsonb,$5,$5),
         ($6,$2,$3,$7,'candidate','active','relevant',false,'relevant',0.7,'AI decision','{}'::jsonb,$5,$5)`,
      [randomUUID(), SPACE, PROJECT, humanItemId, now, randomUUID(), aiItemId],
    );

    const result = await new ProjectResearchOrchestrator(db.pool, CONFIG).resolveQuestionChange(identity, PROJECT, workflowId, "rescreen") as {
      workflow: { state_json: Record<string, unknown> };
      operation: { progress_json: Record<string, unknown> };
    };

    expect(result.workflow.state_json).toMatchObject({
      research_question: "New question", research_question_version: 2,
      previous_research_question: "Old question", previous_research_question_version: 1,
      question_change_mode: "rescreen",
    });
    expect(result.operation.progress_json).toMatchObject({ run_kind: "question_rescreen", research_question_version: 2 });
    const corpus = await db.pool.query<{ source_item_id: string; triage_status: string; triage_confirmed_by_user: boolean; relevance: string | null; confidence: number | null }>(
      `SELECT source_item_id, triage_status, triage_confirmed_by_user, relevance, confidence
         FROM project_corpus_items WHERE project_id=$1 ORDER BY source_item_id`,
      [PROJECT],
    );
    const human = corpus.rows.find((row) => row.source_item_id === humanItemId)!;
    const ai = corpus.rows.find((row) => row.source_item_id === aiItemId)!;
    expect(human).toMatchObject({ triage_status: "included", triage_confirmed_by_user: true, relevance: "relevant", confidence: 0.9 });
    expect(ai).toMatchObject({ triage_status: "new", triage_confirmed_by_user: false, relevance: null, confidence: null });
  });

  it("runs a stage on a workflow and lists checkpoints via a decided checkpoint", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();

    const afterRun = await repo().runStage(identity, PROJECT, workflowId, "research_setup", { run_id: "run-123" });
    expect(afterRun.current_stage).toBe("research_setup");
    expect((afterRun.state_json as { stages: Record<string, unknown> }).stages.research_setup).toMatchObject({
      status: "running",
      run_id: "run-123",
    });

    const checkpoint = await repo().createCheckpoint(identity, PROJECT, workflowId, {
      stageKey: "research_setup",
      checkpointType: "other",
      machineResult: { ok: true },
    });
    expect(checkpoint.status).toBe("pending");

    const decided = await repo().decideCheckpoint(identity, PROJECT, workflowId, checkpoint.id as string, {
      decision: "approved",
      reason: "looks good",
    });
    expect(decided).toMatchObject({ status: "approved", user_decision: "approved", decision_reason: "looks good" });

    const checkpoints = await repo().listCheckpoints(identity, PROJECT, workflowId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.id).toBe(checkpoint.id);
  });

  it("evidence matrix includes only included/maybe corpus items, and rebuild backfills from source links", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const objectId = randomUUID();
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Paper A',$3,$3)`,
      [objectId, SPACE, now],
    );
    const corpusItemId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, role, status, triage_status, read_status,
         metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','included','unread','{}'::jsonb,$5,$5)`,
      [corpusItemId, SPACE, PROJECT, objectId, now],
    );
    const excludedCorpusItemId = randomUUID();
    const excludedObjectId = randomUUID();
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Paper B',$3,$3)`,
      [excludedObjectId, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, role, status, triage_status, read_status,
         metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','excluded','unread','{}'::jsonb,$5,$5)`,
      [excludedCorpusItemId, SPACE, PROJECT, excludedObjectId, now],
    );

    const matrix = await repo().getEvidenceMatrix(identity, PROJECT);
    expect(matrix).toHaveLength(1);
    expect(matrix[0]).toMatchObject({ object_id: objectId, title: "Paper A", triage_status: "included" });

    const rebuilt = await repo().rebuildEvidenceMatrix(identity, PROJECT);
    expect(rebuilt).toHaveLength(1);
  });

  it("computes a real (non-fabricated) integrity result", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();

    // No claim links yet, so the integrity gate has nothing to check
    // and passes cleanly — see projectResearchIntegrityDb.test.ts for the
    // full citation/evidence/gap-finding coverage.
    const report = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    expect(report).toMatchObject({ checked_claim_links: 0, blocking: false });
  });

  it("returns an empty default before screening criteria are saved, then upserts and rejects a bad date range", async () => {
    if (!db.available) return;
    const empty = await repo().getScreeningCriteria(identity, PROJECT);
    expect(empty).toMatchObject({ include_keywords: [], exclude_keywords: [], project_id: PROJECT });

    const saved = await repo().upsertScreeningCriteria(identity, PROJECT, {
      include_keywords: ["transformer", "attention"],
      exclude_keywords: ["survey"],
      // `venues` generalized to a source restriction (R4/D12) — journals,
      // outlets and sites are one concept. `methods` moved into the
      // profile-declared bag, which this Project binds no source for, so it is
      // covered by researchScreeningCriteriaDb rather than here.
      source_restrictions: ["NeurIPS"],
      date_range_start: "2020-01-01T00:00:00.000Z",
      date_range_end: "2024-01-01T00:00:00.000Z",
    });
    expect(saved).toMatchObject({ include_keywords: ["transformer", "attention"], source_restrictions: ["NeurIPS"] });

    const fetched = await repo().getScreeningCriteria(identity, PROJECT);
    expect(fetched).toMatchObject({ exclude_keywords: ["survey"], domain_criteria: {} });

    await expect(
      repo().upsertScreeningCriteria(identity, PROJECT, {
        date_range_start: "2024-01-01T00:00:00.000Z",
        date_range_end: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("enriches the evidence matrix with academic metadata and evidence/annotation counts", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const sourceItemId = randomUUID();
    const corpusItemId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_items (
         id, space_id, owner_user_id, visibility, item_type, title, first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared','feed_entry','Paper A',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
      [sourceItemId, SPACE, OWNER, now],
    );
    const objectId = randomUUID();
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Paper A',$3,$3)`,
      [objectId, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
       VALUES ($1,$2,'paper','https://arxiv.org/abs/2401.00009',$3::jsonb)`,
      [objectId, SPACE, JSON.stringify({ authors: ["A. Author"], categories: ["cs.CL"] })],
    );
    await db.pool.query(
      `INSERT INTO academic_papers (object_id, space_id, arxiv_id, paper_type, created_at, updated_at)
       VALUES ($1,$2,'2401.00009','preprint',$3,$3)`,
      [objectId, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [sourceItemId, SPACE, objectId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, role, status, triage_status, read_status,
         metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','included','unread','{}'::jsonb,$5,$5)`,
      [corpusItemId, SPACE, PROJECT, objectId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_item_sources (id, corpus_item_id, space_id, project_id, source_item_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
    );
    await db.pool.query(
      `INSERT INTO extracted_evidence (
         id, space_id, owner_user_id, visibility, source_item_id, source_object_type, source_object_id, evidence_type, title,
         extraction_method, trust_level, status, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared',$4,'source_item',$4,'excerpt','Key finding','full_text','normal','candidate',$5,$5)`,
      [randomUUID(), SPACE, OWNER, sourceItemId, now],
    );
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$1,'active',$2,$2)`, [OTHER, now]);
    await db.pool.query(
      `INSERT INTO extracted_evidence (
         id,space_id,owner_user_id,visibility,source_item_id,source_object_type,source_object_id,evidence_type,title,
         extraction_method,trust_level,status,created_at,updated_at
       ) VALUES ($1,$2,$3,'private',$4,'source_item',$4,'excerpt','Private finding','full_text','normal','candidate',$5,$5)`,
      [randomUUID(), SPACE, OTHER, sourceItemId, now],
    );
    await db.pool.query(
      `INSERT INTO reader_annotations (
         id,space_id,document_type,document_id,annotation_type,quote_text,anchor_json,visibility,status,
         anchor_state,created_by_user_id,owner_user_id,created_at,updated_at
       ) VALUES ($1,$2,'source_item',$3,'highlight','Private note','{}'::jsonb,'private','active','verified',$4,$4,$5,$5)`,
      [randomUUID(), SPACE, sourceItemId, OTHER, now],
    );

    const matrix = await repo().getEvidenceMatrix(identity, PROJECT);
    expect(matrix).toHaveLength(1);
    expect(matrix[0]).toMatchObject({
      object_id: objectId,
      evidence_count: 1,
      annotation_count: 0,
      academic: { arxiv_id: "2401.00009", paper_type: "preprint", authors: ["A. Author"], categories: ["cs.CL"] },
    });
  });

  it("omits source-backed matrix rows whose object is readable but provenance is summary-only", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$1,'active',$2,$2)`, [OTHER, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, OTHER, now],
    );
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
      [randomUUID(), SPACE, PROJECT, OTHER, now],
    );
    const objectId = randomUUID();
    const sourceItemId = randomUUID();
    const corpusItemId = randomUUID();
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, created_at, updated_at)
       VALUES ($1,$2,'source','Restricted paper','space_shared',$3,$3)`,
      [objectId, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO source_items (
         id,space_id,owner_user_id,created_by_user_id,visibility,access_level,item_type,title,first_seen_at,last_seen_at,
         content_state,retention_policy,created_at,updated_at
       ) VALUES ($1,$2,$3,$3,'space_shared','summary','feed_entry','Restricted provenance',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
      [sourceItemId, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id,space_id,project_id,object_id,role,status,triage_status,read_status,metadata_json,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','included','unread','{}'::jsonb,$5,$5)`,
      [corpusItemId, SPACE, PROJECT, objectId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
    );

    await expect(repo().getEvidenceMatrix(identity, PROJECT)).resolves.toHaveLength(1);
    await expect(repo().getEvidenceMatrix({ spaceId: SPACE, userId: OTHER }, PROJECT)).resolves.toEqual([]);
  });

  it("counts corpus status once per source item when evidence has its own corpus row", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const sourceItemId = randomUUID();
    const evidenceId = randomUUID();
    const sourceCorpusItemId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_items (
         id, space_id, owner_user_id, visibility, item_type, title, first_seen_at, last_seen_at,
         content_state, retention_policy, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared','feed_entry','Paper A',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
      [sourceItemId, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO extracted_evidence (
         id, space_id, owner_user_id, visibility, source_item_id, source_object_type,
         evidence_type, title, extraction_method, trust_level, status, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared',$4,'source_item','excerpt','Evidence A','full_text','normal','candidate',$5,$5)`,
      [evidenceId, SPACE, OWNER, sourceItemId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, source_item_id, role, status, triage_status, read_status,
         metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','new','unread','{}'::jsonb,$5,$5)`,
      [sourceCorpusItemId, SPACE, PROJECT, sourceItemId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_item_sources (id, corpus_item_id, space_id, project_id, source_item_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), sourceCorpusItemId, SPACE, PROJECT, sourceItemId, now],
    );
    const evidenceCorpusItemId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, evidence_id, role, status, triage_status,
         read_status, metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','new','unread','{}'::jsonb,$5,$5)`,
      [evidenceCorpusItemId, SPACE, PROJECT, evidenceId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_item_sources (id, corpus_item_id, space_id, project_id, source_item_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), evidenceCorpusItemId, SPACE, PROJECT, sourceItemId, now],
    );

    const orchestrator = new ProjectResearchOrchestrator(db.pool, CONFIG);
    const countRelevantItems = (orchestrator as unknown as {
      countRelevantItems: (spaceId: string, projectId: string, sourceItemIds: string[]) => Promise<Record<string, number>>;
    }).countRelevantItems.bind(orchestrator);
    await expect(countRelevantItems(SPACE, PROJECT, [sourceItemId])).resolves.toMatchObject({
      total: 1,
      missing_full_text: 1,
      evidence_count: 1,
    });

    const objectId = randomUUID();
    const objectCorpusItemId = randomUUID();
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Paper A',$3,$3)`,
      [objectId, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
       VALUES ($1,$2,'paper','https://example.test/paper-a','{}'::jsonb)`,
      [objectId, SPACE],
    );
    await db.pool.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [sourceItemId, SPACE, objectId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, role, status,
         triage_status, read_status, metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','new','unread','{}'::jsonb,$5,$5)`,
      [objectCorpusItemId, SPACE, PROJECT, objectId, now],
    );
    await db.pool.query(
      `INSERT INTO project_corpus_item_sources (id, corpus_item_id, space_id, project_id, source_item_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), objectCorpusItemId, SPACE, PROJECT, sourceItemId, now],
    );
    await expect(countRelevantItems(SPACE, PROJECT, [sourceItemId])).resolves.toMatchObject({
      total: 1,
      missing_full_text: 0,
      evidence_count: 1,
    });
  });
});
