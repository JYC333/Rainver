import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setProviderHttpClientForTests } from "../src/modules/providers/invocation/invocation.js";
import { openAiChatResponse } from "./support/piAiHttp.js";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { ProjectResearchAreaService } from "../src/modules/projectResearch/areaService.js";
import { ProjectResearchMonitorComparisonService, parseMonitorComparisons } from "../src/modules/projectResearch/monitorComparisonService.js";
import { ProjectResearchIntegrityMonitorService, enqueueDueResearchIntegrityChecks } from "../src/modules/projectResearch/integrityMonitorService.js";
import { writeNote } from "../src/modules/knowledge/noteRevisionService.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { PgReaderRepository } from "../src/modules/reader/repository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { buildJobHandlerRegistry } from "../src/modules/jobs/workerRuntime.js";
import { PROVIDER_TASK_RUN_JOB_TYPE } from "../src/modules/runs/providerTaskRunHandler.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { runBoundedProviderTask } from "../src/modules/runs/boundedProviderTaskRun.js";

const SPACE = "11111111-1111-4111-8111-111111111111"; const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const PROJECT = "55555555-5555-4555-8555-555555555555";
const PROVIDER = "99999999-9999-4999-8999-999999999999";
let config: ServerConfig | undefined;

const db = useTestDatabase(import.meta.filename, { max: 2 });

beforeAll(async () => {
  if (!db.available) return;
  config = loadConfig({
    ...process.env,
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: "/tmp/rainver-research-area-test",
    // Do not inherit package-manager DEBUG namespaces such as "release" as
    // the server's boolean debug configuration.
    SERVER_DEBUG: "false",
  });
}, 180_000);
afterEach(() => { __setProviderHttpClientForTests(null); });
beforeEach(async () => { if (!db.available) return; await resetTables(
  db.pool,
  ["research_checklist_items", "research_evidence_cards", "note_revisions", "note_collection_items", "note_collections", "notes", "space_objects", "project_corpus_items", "source_items", "projects", "space_memberships", "users", "spaces", "runs", "agent_runtime_profiles", "agent_versions", "agents", "model_provider_space_grants", "model_providers", "jobs",
   "provider_task_snapshots", "provider_task_deliveries", "provider_task_controls"],
  { cascade: true },
); const now = new Date().toISOString(); await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]); await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER, now]); await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]); await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Project','active',$4,$4)`, [PROJECT, SPACE, USER, now]);
  await db.pool.query(`INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at) VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`, [PROVIDER, SPACE, USER, now]);
  await db.pool.query(`INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at) VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`, [randomUUID(), PROVIDER, SPACE, USER, now]);
  // Bounded research tasks now invoke the provider in-process, so the fixture
  // needs a real (encrypted) key in the provider's pool rather than a row the
  // agent-run path never resolved.
  if (config) await resolveProviderCommandStore(config).addPoolCredential(SPACE, USER, PROVIDER, { api_key: "test-research-key" });
});

/**
 * Performs the queued bounded ProviderTask the way the worker does, through
 * the registered `provider_task_run` handler, so the test exercises the same
 * path production takes rather than a second one built for it.
 */
async function runQueuedProviderTask(runId: string, attempts = 1, maxAttempts = attempts): Promise<unknown> {
  const registry = buildJobHandlerRegistry(config!);
  return registry.dispatch({
    job_id: randomUUID(),
    space_id: SPACE,
    user_id: USER,
    job_type: PROVIDER_TASK_RUN_JOB_TYPE,
    attempts,
    max_attempts: maxAttempts,
    worker_id: "test-worker",
    payload: { run_id: runId },
  });
}

async function seedCorpusSourceProvenance(corpusItemId: string, sourceItemId: string, now: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
}

describe("Research Area (real Postgres)", () => {
  it("creates four starter notes and enforces optimistic note versions", async () => {
    if (!db.available) return; const service = new ProjectResearchAreaService(db.pool); const identity = { spaceId: SPACE, userId: USER };
    const area = await service.initializeArea(identity, PROJECT);
    expect(area.notes.map((v: { title: string }) => v.title)).toEqual(["Current understanding", "Open questions", "Idea pool", "Experiment log"]);
    const understandingId = area.notes[0]!.id;
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Current finding" }] }] };
    const knowledge = new PgKnowledgeRepository(db.pool);
    const updated = await knowledge.updateNote(identity, understandingId, { expect_version: 1, content_json: doc, plain_text: "Current finding" });
    expect(updated).toMatchObject({ version: 2, plain_text: "Current finding", updated_by_user_id: USER });
    const reader = await new PgReaderRepository(db.pool, { artifactStorageRoot: "/tmp", sandboxRoot: "/tmp" } as ServerConfig).getDocument(identity, "research_notebook", understandingId);
    expect(reader).toMatchObject({ document_type: "research_notebook", document_id: understandingId, normalized_text: "Current finding", content_hash: updated.content_hash });
    await expect(knowledge.updateNote(identity, understandingId, { expect_version: 1, content_json: doc })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("nests the project's auto-created notes folder under the seeded PARA 'Projects' folder", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const projectsFolderId = randomUUID();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Projects','projects_root',100,true,false,$3,$3)`,
      [projectsFolderId, SPACE, now],
    );
    const area = await new ProjectResearchAreaService(db.pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const folder = await db.pool.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM note_collections WHERE id=$1 AND space_id=$2`, [area.notes_collection_id, SPACE],
    );
    expect(folder.rows[0]?.parent_id).toBe(projectsFolderId);
  });

  it("nests under the seeded 'Projects' folder by role even if it was renamed", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const projectsFolderId = randomUUID();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'My Projects','projects_root',100,true,false,$3,$3)`,
      [projectsFolderId, SPACE, now],
    );
    const area = await new ProjectResearchAreaService(db.pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const folder = await db.pool.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM note_collections WHERE id=$1 AND space_id=$2`, [area.notes_collection_id, SPACE],
    );
    expect(folder.rows[0]?.parent_id).toBe(projectsFolderId);
  });

  it("falls back to a root-level folder when no 'Projects' folder has been seeded (e.g. it was renamed or deleted)", async () => {
    if (!db.available) return;
    const area = await new ProjectResearchAreaService(db.pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const folder = await db.pool.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM note_collections WHERE id=$1 AND space_id=$2`, [area.notes_collection_id, SPACE],
    );
    expect(folder.rows[0]?.parent_id).toBeNull();
  });

  it("does not initialize a area after its Project is archived", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE projects SET status='archived',archived_at=now() WHERE id=$1 AND space_id=$2`, [PROJECT, SPACE]);
    await expect(
      new ProjectResearchAreaService(db.pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM note_collections WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    )).rows[0]?.count).toBe("0");
  });

  it("applies AI block ops without touching other blocks and supports rollback from the revision history", async () => {
    if (!db.available) return; const service = new ProjectResearchAreaService(db.pool); const identity = { spaceId: SPACE, userId: USER };
    const area = await service.initializeArea(identity, PROJECT);
    const understandingId = area.notes[0]!.id;
    const knowledge = new PgKnowledgeRepository(db.pool);
    const boldDoc = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "User formatted claim" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second block" }] },
    ] };
    await knowledge.updateNote(identity, understandingId, { expect_version: 1, content_json: boldDoc, plain_text: "User formatted claim\n\nSecond block" });
    // Blocks carry a system-assigned stable id; capture the untouched block's
    // id up front so the AI write can be held to preserving it.
    const blockContent = (note: { content_json: unknown }) =>
      (note.content_json as { content: Array<Record<string, unknown>> }).content;
    const beforeFirst = blockContent(await knowledge.getNote(identity, understandingId) as { content_json: unknown })[0]!;
    const beforeBlockId = (beforeFirst.attrs as { blockId?: string } | undefined)?.blockId;
    expect(beforeBlockId).toEqual(expect.any(String));
    const written = await writeNote(db.pool, {
      spaceId: SPACE, noteId: understandingId,
      content: { kind: "ops", ops: [{ op: "replace", index: 1, count: 1, markdown: "Replaced second block" }, { op: "append", markdown: "## Monitoring update\n\n- New contradiction" }] },
      source: "ai_monitoring", refs: ["item-1"], diff: { ops: [] },
    });
    expect(written.outcome).toBe("written");
    if (written.outcome !== "written") return;
    // The user's formatted block survives untouched — the whole point of block
    // ops — including its identity, so anchors into it stay valid.
    const afterFirst = blockContent(written.note)[0]!;
    const { attrs: afterAttrs, ...afterUserContent } = afterFirst;
    expect(afterUserContent).toEqual(boldDoc.content[0]);
    expect((afterAttrs as { blockId?: string } | undefined)?.blockId).toBe(beforeBlockId);
    expect(written.note.plain_text).toBe("User formatted claim\n\nReplaced second block\n\nMonitoring update\n\n- New contradiction");
    const revisions = await knowledge.listNoteRevisions(identity, understandingId);
    expect(revisions.map((row) => [row.version, row.source])).toEqual([[3, "ai_monitoring"], [2, "user_edit"], [1, "seed"]]);
    const restored = await knowledge.rollbackNote(identity, understandingId, 2);
    expect(restored).toMatchObject({ version: 4, plain_text: "User formatted claim\n\nSecond block" });
    expect((await knowledge.listNoteRevisions(identity, understandingId)).map((row) => [row.version, row.source])[0]).toEqual([4, "rollback"]);
  });

  it("keeps user-edited paper cards when deep analysis runs again", async () => {
    if (!db.available) return; const now = new Date().toISOString(); const item = randomUUID(); const corpus = randomUUID();
    await db.pool.query(`INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES ($1,$2,$3,'space_shared','feed_entry','Paper',$4,$4,'excerpt_saved','summary_only',$4,$4)`, [item, SPACE, USER, now]);
    await db.pool.query(`INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at) VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`, [corpus, SPACE, PROJECT, item, now]);
    await seedCorpusSourceProvenance(corpus, item, now);
    const service = new ProjectResearchAreaService(db.pool);
    const first = await service.materializeEvidenceCardsFromDeepAnalysis({ spaceId: SPACE, projectId: PROJECT, runId: randomUUID(), summaries: [{ source_item_id: item, summary_markdown: "WHY: Relevant\nHOW: Experiment\nWHAT: Result" }] });
    expect(first).toBe(1);
    await service.upsertEvidenceCard({ spaceId: SPACE, userId: USER }, PROJECT, item, { why_md: "My reason", how_md: "My method", what_md: "My result" });
    const second = await service.materializeEvidenceCardsFromDeepAnalysis({ spaceId: SPACE, projectId: PROJECT, runId: randomUUID(), summaries: [{ source_item_id: item, summary_markdown: "WHY: Replaced\nHOW: Replaced\nWHAT: Replaced" }] });
    expect(second).toBe(0);
    expect((await db.pool.query(`SELECT why_md,edited_by_user FROM research_evidence_cards WHERE source_item_id=$1`, [item])).rows[0]).toEqual({ why_md: "My reason", edited_by_user: true });
  });

  it("materializes every monitoring stance as an Evidence Signal and only escalates material comparisons", async () => {
    if (!db.available) return;
    const now = new Date().toISOString(); const workflow = randomUUID(); const operation = randomUUID();
    const supporting = randomUUID(); const contradicting = randomUUID();
    await new ProjectResearchAreaService(db.pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const thread = await new InquiryThreadService(db.pool).createThread(
      { spaceId: SPACE, userId: USER },
      PROJECT,
      { kind: "question", statement: "Does the effect replicate?" },
    );
    const threadScope = [{
      thread_id: String(thread.id),
      version: Number(thread.version),
      kind: "question" as const,
      statement: String(thread.statement),
    }];
    await insertResearchWorkflowFixture(db.pool, {
      id: workflow, spaceId: SPACE, projectId: PROJECT, startedByUserId: USER,
      primaryThreadId: String(thread.id), state: {
        research_question: "Does the effect replicate?",
        thread_scope: threadScope,
      }, now,
    });
    await db.pool.query(
      `INSERT INTO project_operations (
         id, space_id, project_id, kind, title, status, progress_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'research', 'Monitoring scan', 'active',
                 '{}'::jsonb, $4, $4)`,
      [operation, SPACE, PROJECT, now],
    );
    for (const [item, title] of [[supporting, "Supporting paper"], [contradicting, "Contradicting paper"]]) {
      await db.pool.query(
        `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared','feed_entry',$4,$5,$5,'excerpt_saved','summary_only',$5,$5)`,
        [item, SPACE, USER, title, now],
      );
      const corpusItemId = randomUUID();
      await db.pool.query(
        `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
        [corpusItemId, SPACE, PROJECT, item, now],
      );
      await seedCorpusSourceProvenance(corpusItemId, item, now);
    }
    await db.pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,2,2,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, workflow, operation, `operation:${operation}`, now],
    );
    const comparisonRun = randomUUID();
    const comparisons = parseMonitorComparisons({ comparisons: [
      { source_item_id: supporting, stance: "supports", detail: "Replicates the current effect.", affected_sections: ["understanding"] },
      { source_item_id: contradicting, stance: "contradicts", detail: "Finds no effect under stronger controls.", affected_sections: ["understanding", "questions"] },
    ] }, [supporting, contradicting]);
    const comparisonService = new ProjectResearchMonitorComparisonService(db.pool);
    const result = await comparisonService.persistComparisons({
      spaceId: SPACE, projectId: PROJECT, workflowId: workflow, operationId: operation, runId: comparisonRun, comparisons,
      researchQuestion: "Does the effect replicate?", threadScope, instructedByUserId: USER,
    });
    expect(result.signalIds).toHaveLength(2);
    expect((await db.pool.query(`SELECT supports_count,contradicts_count,new_direction_count FROM research_scan_summaries WHERE operation_id=$1`, [operation])).rows[0])
      .toEqual({ supports_count: 1, contradicts_count: 1, new_direction_count: 0 });
    // The notebook is untouched — monitoring no longer co-edits it directly.
    // Resolved by role, and refs read from the note's latest revision: the
    // title binding and `notes.refs_json` are both gone (NA, N8).
    const section = (await db.pool.query(
      `SELECT n.version, n.plain_text, nr.refs_json
         FROM notes n
         JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
         LEFT JOIN LATERAL (
           SELECT refs_json FROM note_revisions
            WHERE note_id=n.object_id AND space_id=n.space_id
            ORDER BY version DESC LIMIT 1
         ) nr ON true
        WHERE n.role_project_id=$1 AND n.project_role='understanding'`,
      [PROJECT],
    )).rows[0];
    expect(section).toMatchObject({ version: 1, refs_json: [] });

    const signals = (await db.pool.query<{ classification: string; is_material: boolean; status: string; thread_id: string }>(
      `SELECT classification,is_material,status,thread_id
         FROM inquiry_evidence_signals
        WHERE space_id=$1 AND project_id=$2
        ORDER BY classification`,
      [SPACE, PROJECT],
    )).rows;
    expect(signals).toEqual([
      { classification: "contradicts", is_material: true, status: "consolidated", thread_id: thread.id },
      { classification: "supports", is_material: false, status: "auto_attached", thread_id: thread.id },
    ]);
    const candidate = (await db.pool.query<{ candidate_kind: string; status: string }>(
      `SELECT candidate_kind,status FROM inquiry_signal_candidates WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    )).rows[0];
    expect(candidate).toEqual({ candidate_kind: "contradiction", status: "pending" });

    const supportOnlyOperation = randomUUID();
    await db.pool.query(
      `INSERT INTO project_operations (
         id, space_id, project_id, kind, title, status, progress_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'research', 'Support-only scan', 'active',
                 '{}'::jsonb, $4, $4)`,
      [supportOnlyOperation, SPACE, PROJECT, now],
    );
    await db.pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, workflow, supportOnlyOperation, `operation:${supportOnlyOperation}`, now],
    );
    const supportOnly = await comparisonService.persistComparisons({
      spaceId: SPACE, projectId: PROJECT, workflowId: workflow, operationId: supportOnlyOperation, runId: randomUUID(),
      researchQuestion: "Does the effect replicate?", threadScope, instructedByUserId: USER,
      comparisons: parseMonitorComparisons(
        { comparisons: [{ source_item_id: supporting, stance: "supports", detail: "Replicates the current effect.", affected_sections: ["understanding"] }] },
        [supporting],
      ),
    });
    expect(supportOnly.signalIds).toHaveLength(1);
    expect((await db.pool.query(`SELECT n.version FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id WHERE so.primary_project_id=$1 AND so.title='Current understanding'`, [PROJECT])).rows[0]).toEqual({ version: 1 });
    expect((await db.pool.query(`SELECT count(*)::int AS count FROM inquiry_evidence_signals WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT])).rows[0]?.count).toBe(2);
  });

  it("deduplicates cited-DOI integrity alerts and creates review work", async () => {
    if (!db.available) return;
    const now = new Date().toISOString(); const workflow = randomUUID(); const sourceItem = randomUUID();
    const service = new ProjectResearchAreaService(db.pool);
    const area = await service.initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    await insertResearchWorkflowFixture(db.pool, {
      id: workflow, spaceId: SPACE, projectId: PROJECT, startedByUserId: USER,
      currentStage: "monitoring", now,
    });
    await db.pool.query(
      `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,metadata_json,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
       VALUES ($1,$2,$3,'space_shared','feed_entry','Cited paper',$4::jsonb,$5,$5,'excerpt_saved','summary_only',$5,$5)`,
      [sourceItem, SPACE, USER, JSON.stringify({ doi: "10.1000/original" }), now],
    );
    const corpusItemId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'reference','active','relevant',true,'read',$5,$5)`,
      [corpusItemId, SPACE, PROJECT, sourceItem, now],
    );
    await seedCorpusSourceProvenance(corpusItemId, sourceItem, now);
    const understandingId = area.notes[0]!.id;
    // Refs live on `note_revisions` now (N8), and the only writer is
    // `writeNote` — so the fixture goes through it rather than reaching past
    // it into a column, which is what let the old copy drift in the first place.
    await writeNote(db.pool, {
      spaceId: SPACE,
      noteId: understandingId,
      content: { kind: "doc", doc: { type: "doc", content: [] } },
      source: "ai_adhoc",
      refs: [sourceItem],
    });
    const monitor = new ProjectResearchIntegrityMonitorService(db.pool, async () => ({ message: { "updated-by": [
      { DOI: "10.1000/retraction", type: "retraction", source: "retraction-watch" },
    ] } }));
    const first = await monitor.check({ spaceId: SPACE, projectId: PROJECT, workflowId: workflow, userId: USER });
    const second = await monitor.check({ spaceId: SPACE, projectId: PROJECT, workflowId: workflow, userId: USER });
    expect(first.alerts).toHaveLength(1); expect(first.checkpointId).toBeTruthy(); expect(first.checklistItemIds).toHaveLength(1);
    expect(second.alerts).toHaveLength(0);
    expect(Number((await db.pool.query(`SELECT count(*) AS count FROM research_integrity_alerts WHERE project_id=$1`, [PROJECT])).rows[0]?.count)).toBe(1);
    expect((await db.pool.query(`SELECT text,origin FROM research_checklist_items WHERE project_id=$1`, [PROJECT])).rows[0]).toMatchObject({ origin: "agent" });
    expect((await db.pool.query(`SELECT integrity_alerts_json FROM research_scan_summaries WHERE workflow_id=$1`, [workflow])).rows[0]?.integrity_alerts_json).toMatchObject([{ event_type: "retraction", doi: "10.1000/original" }]);
    expect((await db.pool.query(`SELECT checkpoint_type,status FROM project_research_checkpoints WHERE workflow_id=$1`, [workflow])).rows[0]).toEqual({ checkpoint_type: "integrity_gate", status: "pending" });
    expect(await enqueueDueResearchIntegrityChecks(db.pool, new Date("2026-07-19T12:00:00.000Z"))).toBe(1);
    expect(await enqueueDueResearchIntegrityChecks(db.pool, new Date("2026-07-19T13:00:00.000Z"))).toBe(0);
  });

  it("askAi records a bounded ProviderTask run against the contracted section, applies the edit, and counts against the shared daily budget", async () => {
    if (!db.available || !config) return;
    // ADR 0022: ad-hoc analysis is bounded single-shot structured generation,
    // so it is a `provider_task` Run performed in-process by the providers
    // module - no Agent, no AgentVersion and no manufactured Runtime Profile.
    __setProviderHttpClientForTests({
      fetch: async () => openAiChatResponse({
        choices: [{ message: { content: JSON.stringify({ notebook_update: { ops: [{ op: "append", index: null, count: null, markdown: "Bounded analysis result" }], refs: [] } }) } }],
        model: "test-model",
        usage: {},
      }),
    });
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(db.pool, config);
    const area = await service.initializeArea(identity, PROJECT);

    const edited = await service.askAi(identity, PROJECT, {
      prompt: "Rewrite the current understanding.",
      section_key: "understanding",
      execution: { model_provider_id: PROVIDER },
    });
    // Admitted and made durable on the request, performed by the worker: the
    // request path no longer holds a provider call open, and a crash can no
    // longer strand a succeeded Run whose edit never reached the note.
    expect(edited).toMatchObject({ daily_limit: 20, daily_used: 1, status: "queued" });
    const queuedRun = (await db.pool.query<{
      status: string; model_provider_id: string | null; provider_task_control_id: string | null; started_at: string | null;
    }>(
      `SELECT status,model_provider_id,provider_task_control_id,started_at FROM runs WHERE id=$1`,
      [edited.run_id],
    )).rows[0];
    expect(queuedRun).toMatchObject({
      status: "queued", model_provider_id: null, provider_task_control_id: null, started_at: null,
    });
    const job = (await db.pool.query<{ job_type: string; payload_json: { run_id?: string } }>(
      `SELECT job_type,payload_json FROM jobs WHERE id=$1`, [edited.job_id],
    )).rows[0];
    expect(job).toMatchObject({ job_type: "provider_task_run", payload_json: { run_id: edited.run_id } });

    await runQueuedProviderTask(edited.run_id);

    const editRun = (await db.pool.query<{
      capability_id: string; execution_kind: string; status: string;
      agent_id: string | null; agent_version_id: string | null;
      runtime_profile_id: string | null; runtime_key: string | null; runtime_profile_snapshot_json: unknown;
      provider_task_control_id: string | null; provider_task_delivery_id: string | null; provider_task_snapshot_id: string | null;
      model_provider_id: string | null; project_id: string | null;
      contract_snapshot_json: { workflow_input_json?: { research_adhoc?: unknown } };
    }>(
      `SELECT capability_id,execution_kind,status,agent_id,agent_version_id,runtime_profile_id,runtime_key,
              runtime_profile_snapshot_json,provider_task_control_id,provider_task_delivery_id,
              provider_task_snapshot_id,model_provider_id,project_id,contract_snapshot_json
         FROM runs WHERE id=$1`, [edited.run_id],
    )).rows[0];
    expect(editRun?.capability_id).toBe("research.adhoc_analyze");
    expect(editRun?.execution_kind).toBe("provider_task");
    expect(editRun?.status).toBe("succeeded");
    expect(editRun?.agent_id).toBeNull();
    expect(editRun?.agent_version_id).toBeNull();
    expect(editRun?.runtime_profile_id).toBeNull();
    expect(editRun?.runtime_key).toBeNull();
    expect(editRun?.runtime_profile_snapshot_json).toBeNull();
    expect(editRun?.provider_task_control_id).toBeTruthy();
    expect(editRun?.provider_task_delivery_id).toBeTruthy();
    expect(editRun?.provider_task_snapshot_id).toBeTruthy();
    expect(editRun?.model_provider_id).toBe(PROVIDER);
    expect(editRun?.project_id).toBe(PROJECT);
    expect(editRun?.contract_snapshot_json.workflow_input_json?.research_adhoc).toBeTruthy();
    // The bounded task manufactures no Agent and no Runtime Profile at all.
    expect(Number((await db.pool.query(`SELECT count(*) AS count FROM agents WHERE space_id=$1 AND agent_kind='system_research'`, [SPACE])).rows[0]?.count)).toBe(0);
    expect(Number((await db.pool.query(`SELECT count(*) AS count FROM agent_runtime_profiles WHERE space_id=$1`, [SPACE])).rows[0]?.count)).toBe(0);
    // The research outcome is unchanged: the block ops land on the target note
    // as an `ai_adhoc` revision attributed to the bounded Run.
    const revision = (await db.pool.query<{ source: string; created_by_run_id: string | null }>(
      `SELECT source,created_by_run_id FROM note_revisions WHERE note_id=$1 AND created_by_run_id=$2`,
      [area.notes[0]!.id, edited.run_id],
    )).rows[0];
    expect(revision).toMatchObject({ source: "ai_adhoc", created_by_run_id: edited.run_id });
    const note = (await db.pool.query<{ plain_text: string | null }>(
      `SELECT plain_text FROM notes WHERE object_id=$1`, [area.notes[0]!.id],
    )).rows[0];
    expect(note?.plain_text).toContain("Bounded analysis result");
  });

  it("settles a failed bounded task as a failed ProviderTask run once the job has no retries left", async () => {
    if (!db.available || !config) return;
    __setProviderHttpClientForTests({ fetch: async () => new Response("{}", { status: 500 }) });
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(db.pool, config);
    await service.initializeArea(identity, PROJECT);

    // Admission succeeds whatever the provider is doing: a provider failure is
    // the worker's problem now, not a 502 on the person's request.
    const queued = await service.askAi(identity, PROJECT, {
      prompt: "Rewrite the current understanding.",
      section_key: "understanding",
      execution: { model_provider_id: PROVIDER },
    });
    expect(queued).toMatchObject({ status: "queued" });

    // With retries left the job throws so it gets another attempt, and the Run
    // is not burned by one transient provider failure.
    await expect(runQueuedProviderTask(queued.run_id as string, 1, 3)).rejects.toThrow();
    expect((await db.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id=$1`, [queued.run_id],
    )).rows[0]?.status).toBe("running");

    await runQueuedProviderTask(queued.run_id as string, 3, 3);
    const run = (await db.pool.query<{ execution_kind: string; status: string; agent_id: string | null; error_json: { error_code?: string } | null }>(
      `SELECT execution_kind,status,agent_id,error_json FROM runs WHERE space_id=$1 AND capability_id='research.adhoc_analyze'`,
      [SPACE],
    )).rows[0];
    expect(run).toMatchObject({ execution_kind: "provider_task", status: "failed", agent_id: null });
  });

  it("keeps one Run for one bounded task however many provider attempts its key pool makes", async () => {
    if (!db.available || !config) return;
    // The lifecycle rule in RUNS_AND_OUTPUTS.md, and the one the two
    // hand-rolled wrappers disagreed on: Daily Reports used to create a new
    // Run per attempt and fail each, so a task that succeeded on the second
    // key left a failed Run beside it claiming the same work.
    await resolveProviderCommandStore(config).addPoolCredential(SPACE, USER, PROVIDER, { api_key: "second-research-key" });
    let calls = 0;
    __setProviderHttpClientForTests({
      fetch: async () => {
        calls += 1;
        // A rate limit is transient, so the pool rotates to the next key.
        if (calls === 1) return new Response(JSON.stringify({ error: "slow down" }), { status: 429 });
        return openAiChatResponse({
          choices: [{ message: { content: JSON.stringify({ notebook_update: { ops: [{ op: "append", index: null, count: null, markdown: "Second key answered" }], refs: [] } }) } }],
          model: "test-model",
          usage: {},
        });
      },
    });
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(db.pool, config);
    await service.initializeArea(identity, PROJECT);
    const queued = await service.askAi(identity, PROJECT, {
      prompt: "Rewrite the current understanding.",
      section_key: "understanding",
      execution: { model_provider_id: PROVIDER },
    });
    await runQueuedProviderTask(queued.run_id as string);

    expect(calls).toBeGreaterThan(1);
    const runs = (await db.pool.query<{ id: string; status: string }>(
      `SELECT id,status FROM runs WHERE space_id=$1 AND capability_id='research.adhoc_analyze'`, [SPACE],
    )).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: queued.run_id, status: "succeeded" });
    // Every attempt linked itself to that one Run in the ProviderTask ledger.
    const linked = (await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM provider_task_controls WHERE control_json->>'run_id'=$1`,
      [queued.run_id],
    )).rows[0];
    expect(Number(linked?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("refuses to perform a queued ProviderTask Run nothing knows how to run, and skips one already settled", async () => {
    if (!db.available || !config) return;
    const runs = new PgRunRepository(db.pool);
    const unknown = await runs.createQueuedProviderTaskRun({
      space_id: SPACE,
      user_id: USER,
      trigger_origin: "manual",
      run_type: "agent",
      task: "not_a_registered_task",
      prompt: "Do something nobody registered.",
      project_id: PROJECT,
      capability_id: "research.not_a_capability",
    });
    // No retry will make an unregistered kind runnable, so it settles rather
    // than sitting queued in the Run list forever.
    await runQueuedProviderTask(unknown.id);
    expect((await db.pool.query<{ status: string; error_json: { error_code?: string } | null }>(
      `SELECT status,error_json FROM runs WHERE id=$1`, [unknown.id],
    )).rows[0]).toMatchObject({ status: "failed", error_json: { error_code: "provider_task_kind_unregistered" } });

    // A reclaimed job whose predecessor already finished must not spend the
    // provider a second time.
    const result = await runQueuedProviderTask(unknown.id) as { skipped?: boolean; status?: string };
    expect(result).toMatchObject({ skipped: true, status: "failed" });
  });

  it("settles a queued ProviderTask Run whose preparer can never rebuild it, once the job has no retries left", async () => {
    if (!db.available || !config) return;
    // The preparer reads the Run's frozen contract; a Run that never froze its
    // provider binding can never be rebuilt, and nothing downstream settled it
    // — `recoverStaleRuns` only reclaims rows that actually started, so the
    // Run sat `queued` forever while still counting against the daily budget.
    const runs = new PgRunRepository(db.pool);
    const stranded = await runs.createQueuedProviderTaskRun({
      space_id: SPACE,
      user_id: USER,
      trigger_origin: "manual",
      run_type: "agent",
      task: "project_research_adhoc_analyze",
      prompt: "Rewrite the current understanding.",
      project_id: PROJECT,
      capability_id: "research.adhoc_analyze",
      contract_snapshot: { source: { kind: "direct", id: null } },
    });

    // With retries left the Run is left alone: the throw is what buys the
    // next attempt, and one transient failure must not burn the task.
    await expect(runQueuedProviderTask(stranded.id, 1, 3)).rejects.toThrow(/provider binding/);
    expect((await db.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id=$1`, [stranded.id],
    )).rows[0]?.status).toBe("queued");

    await expect(runQueuedProviderTask(stranded.id, 3, 3)).rejects.toThrow(/provider binding/);
    expect((await db.pool.query<{ status: string; started_at: string | null; error_json: { error_code?: string } | null }>(
      `SELECT status,started_at,error_json FROM runs WHERE id=$1`, [stranded.id],
    )).rows[0]).toMatchObject({
      // `failed`, the bounded Run's one failure terminal — not `agent_run`'s
      // `orphaned`, which means a Run that was running when the execution
      // registry was lost. This one never started.
      status: "failed",
      started_at: null,
      error_json: { error_code: "job_exhausted" },
    });
  });

  it("refuses to start a bounded ProviderTask Run that has already left the queue", async () => {
    if (!db.available || !config) return;
    let calls = 0;
    __setProviderHttpClientForTests({ fetch: async () => { calls += 1; return new Response("{}", { status: 200 }); } });
    const runs = new PgRunRepository(db.pool);
    const queued = await runs.createQueuedProviderTaskRun({
      space_id: SPACE,
      user_id: USER,
      trigger_origin: "manual",
      run_type: "agent",
      task: "project_research_adhoc_analyze",
      prompt: "Rewrite the current understanding.",
      project_id: PROJECT,
      capability_id: "research.adhoc_analyze",
      contract_snapshot: { source: { kind: "direct", id: null } },
    });
    // Cancelled while it sat queued — the window the worker's own status check
    // cannot close, because it reads the Run before the attempt starts.
    await runs.markRunTerminal({
      run_id: queued.id,
      space_id: SPACE,
      status: "cancelled",
      output_json: {},
      error_json: { error_code: "run_cancelled", error_text: "Run cancelled" },
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });

    const result = await runBoundedProviderTask(db.pool, config, {
      completion: "text",
      runId: queued.id,
      spaceId: SPACE,
      userId: USER,
      task: "project_research_adhoc_analyze",
      capabilityId: "research.adhoc_analyze",
      projectId: PROJECT,
      providerId: PROVIDER,
      model: "test-model",
      system: "Bounded research.",
      messages: [{ role: "user", content: "Rewrite the current understanding." }],
      prompt: "Rewrite the current understanding.",
      runType: "agent",
      triggerOrigin: "manual",
      spend: { kind: "person", user_id: USER },
      failRunOnError: true,
    });

    expect(result).toMatchObject({ ok: false, runId: queued.id, errorCode: "run_not_queued" });
    // The provider was never spent, the attempt's ledger rows rolled back with
    // it, and the cancellation still stands: settling here would have replaced
    // it with a failure of a task nobody performed.
    expect(calls).toBe(0);
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM provider_task_controls WHERE space_id=$1`, [SPACE],
    )).rows[0]?.count).toBe("0");
    expect((await db.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id=$1`, [queued.id],
    )).rows[0]?.status).toBe("cancelled");
  });

  it("reports no Run id when the attempt that created one rolled back", async () => {
    if (!db.available || !config) return;
    __setProviderHttpClientForTests({
      fetch: async () => openAiChatResponse({
        choices: [{ message: { content: "answered" } }], model: "test-model", usage: {},
      }),
    });
    // The attempt links its ledger rows to the Run it just created, in the
    // same transaction. A failure there rolls the Run away with them, and the
    // caller used to be handed the id of a row that no longer exists.
    await db.pool.query(
      `CREATE FUNCTION refuse_provider_task_link() RETURNS trigger AS $$
         BEGIN RAISE EXCEPTION 'provider task link update refused'; END;
       $$ LANGUAGE plpgsql`,
    );
    await db.pool.query(
      `CREATE TRIGGER refuse_provider_task_link BEFORE UPDATE ON provider_task_controls
         FOR EACH ROW EXECUTE FUNCTION refuse_provider_task_link()`,
    );
    try {
      const result = await runBoundedProviderTask(db.pool, config, {
        completion: "text",
        spaceId: SPACE,
        userId: USER,
        task: "project_research_adhoc_analyze",
        capabilityId: "research.adhoc_analyze",
        projectId: PROJECT,
        providerId: PROVIDER,
        model: "test-model",
        system: "Bounded research.",
        messages: [{ role: "user", content: "Rewrite the current understanding." }],
        prompt: "Rewrite the current understanding.",
        runType: "agent",
        triggerOrigin: "manual",
        spend: { kind: "person", user_id: USER },
      });
      expect(result).toMatchObject({ ok: false, runId: null });
      expect((await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM runs WHERE space_id=$1 AND execution_kind='provider_task'`,
        [SPACE],
      )).rows[0]?.count).toBe("0");
    } finally {
      await db.pool.query(`DROP TRIGGER refuse_provider_task_link ON provider_task_controls`);
      await db.pool.query(`DROP FUNCTION refuse_provider_task_link()`);
    }
  });

  it("notebookChat persists both turns to one reusable session and shares askAi's daily budget", async () => {
    if (!db.available || !config) return;
    // The provider is unreachable in tests; a fast, deterministic failure lets
    // us assert the graceful-failure path (message persistence, session
    // reuse, shared budget) without depending on the full structured-output
    // adapter pipeline — success-path notebook writes are already covered via
    // applyOpsWithConflictFallback in projectResearchSynthesisReconcileDb.test.ts.
    __setProviderHttpClientForTests({ fetch: async () => new Response("{}", { status: 500 }) });
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(db.pool, config);
    await service.initializeArea(identity, PROJECT);

    const first = await service.notebookChat(identity, PROJECT, {
      message: "What is the current understanding?",
      execution: { model_provider_id: PROVIDER },
    });
    expect(first.ok).toBe(false);
    expect(first.daily_limit).toBe(20);
    expect(first.daily_used).toBe(1);
    const sessionId = first.session_id;
    expect(sessionId).toBeTruthy();
    // ADR 0022: notebook chat is bounded structured generation too - its Run
    // is a ProviderTask Run with no Agent or Runtime Profile, even when the
    // bounded call fails.
    const chatRun = (await db.pool.query<{
      execution_kind: string; status: string; agent_id: string | null; runtime_profile_id: string | null;
      provider_task_control_id: string | null; capability_id: string | null;
    }>(
      `SELECT execution_kind,status,agent_id,runtime_profile_id,provider_task_control_id,capability_id
         FROM runs WHERE id=$1`, [first.run_id],
    )).rows[0];
    expect(chatRun).toMatchObject({
      execution_kind: "provider_task", status: "failed", agent_id: null,
      runtime_profile_id: null, capability_id: "research.ask",
    });
    expect(chatRun?.provider_task_control_id).toBeTruthy();

    const second = await service.notebookChat(identity, PROJECT, {
      message: "Follow-up question.",
      session_id: sessionId,
      execution: { model_provider_id: PROVIDER },
    });
    // Reuses the same session (multi-turn) and keeps drawing from askAi's
    // shared 20/project/day db.pool.
    expect(second.session_id).toBe(sessionId);
    expect(second.daily_used).toBe(2);

    const messages = (await db.pool.query<{ role: string; content: string }>(
      `SELECT role,content FROM messages WHERE session_id=$1 ORDER BY created_at ASC`, [sessionId],
    )).rows;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[0]?.content).toBe("What is the current understanding?");
    expect(messages[2]?.content).toBe("Follow-up question.");
  });

  it("notebookChat rejects a session_id that belongs to a different project", async () => {
    if (!db.available || !config) return;
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(db.pool, config);
    await service.initializeArea(identity, PROJECT);
    const otherProject = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Other','active',$4,$4)`, [otherProject, SPACE, USER, now]);
    const otherSession = await db.pool.query<{ id: string }>(
      `INSERT INTO sessions (id,space_id,user_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5) RETURNING id`,
      [randomUUID(), SPACE, USER, otherProject, now],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    await expect(service.notebookChat(identity, PROJECT, {
      message: "Hello", session_id: otherSession.rows[0]!.id, execution: { model_provider_id: PROVIDER },
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});
