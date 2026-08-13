import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig, type ServerConfig } from "../src/config";
import { __setProviderHttpClientForTests } from "../src/modules/providers";
import { migrate } from "../src/db/migrator";
import { ProjectResearchAreaService } from "../src/modules/projectResearch/areaService";
import { ProjectResearchMonitorComparisonService, parseMonitorComparisons } from "../src/modules/projectResearch/monitorComparisonService";
import { ProjectResearchIntegrityMonitorService, enqueueDueResearchIntegrityChecks } from "../src/modules/projectResearch/integrityMonitorService";
import { writeNote } from "../src/modules/knowledge/noteRevisionService";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { PgReaderRepository } from "../src/modules/reader/repository";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

const SPACE = "11111111-1111-4111-8111-111111111111"; const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const PROJECT = "55555555-5555-4555-8555-555555555555";
const PROVIDER = "99999999-9999-4999-8999-999999999999";
let database: TestPostgresDatabase | undefined; let pool: Pool | undefined; let available = false; let config: ServerConfig | undefined;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[research-area-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  pool = new Pool({ connectionString: database.getConnectionUri(), max: 2 });
  await migrate(pool, join(process.cwd(), "migrations"));
  config = loadConfig({
    ...process.env,
    SERVER_DATABASE_URL: database.getConnectionUri(),
    // Do not inherit package-manager DEBUG namespaces such as "release" as
    // the server's boolean debug configuration.
    SERVER_DEBUG: "false",
  });
  available = true;
}, 180_000);
afterAll(async () => { await pool?.end(); await database?.stop(); });
afterEach(() => { __setProviderHttpClientForTests(null); });
beforeEach(async () => { if (!available || !pool) return; await pool.query(`TRUNCATE research_checklist_items,research_evidence_cards,note_revisions,note_collection_items,note_collections,notes,space_objects,project_corpus_items,source_items,projects,space_memberships,users,spaces,runs,agent_runtime_profiles,agent_versions,agents,model_provider_space_grants,model_providers CASCADE`); const now = new Date().toISOString(); await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]); await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]); await pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]); await pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Project','active',$4,$4)`, [PROJECT, SPACE, USER, now]);
  await pool.query(`INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at) VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`, [PROVIDER, SPACE, USER, now]);
  await pool.query(`INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at) VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`, [randomUUID(), PROVIDER, SPACE, USER, now]);
});

async function seedCorpusSourceProvenance(corpusItemId: string, sourceItemId: string, now: string): Promise<void> {
  await pool!.query(
    `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
}

describe("Research Area (real Postgres)", () => {
  it("creates four starter notes and enforces optimistic note versions", async () => {
    if (!available || !pool) return; const service = new ProjectResearchAreaService(pool); const identity = { spaceId: SPACE, userId: USER };
    const area = await service.initializeArea(identity, PROJECT);
    expect(area.notes.map((v: { title: string }) => v.title)).toEqual(["Current understanding", "Open questions", "Idea pool", "Experiment log"]);
    const understandingId = area.notes[0]!.id;
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Current finding" }] }] };
    const knowledge = new PgKnowledgeRepository(pool);
    const updated = await knowledge.updateNote(identity, understandingId, { expect_version: 1, content_json: doc, plain_text: "Current finding" });
    expect(updated).toMatchObject({ version: 2, plain_text: "Current finding", updated_by_user_id: USER });
    const reader = await new PgReaderRepository(pool, { artifactStorageRoot: "/tmp", sandboxRoot: "/tmp" } as ServerConfig).getDocument(identity, "research_notebook", understandingId);
    expect(reader).toMatchObject({ document_type: "research_notebook", document_id: understandingId, normalized_text: "Current finding", content_hash: updated.content_hash });
    await expect(knowledge.updateNote(identity, understandingId, { expect_version: 1, content_json: doc })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("nests the project's auto-created notes folder under the seeded PARA 'Projects' folder", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    const projectsFolderId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Projects','projects_root',100,true,false,$3,$3)`,
      [projectsFolderId, SPACE, now],
    );
    const area = await new ProjectResearchAreaService(pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const folder = await pool.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM note_collections WHERE id=$1 AND space_id=$2`, [area.notes_collection_id, SPACE],
    );
    expect(folder.rows[0]?.parent_id).toBe(projectsFolderId);
  });

  it("nests under the seeded 'Projects' folder by role even if it was renamed", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    const projectsFolderId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'My Projects','projects_root',100,true,false,$3,$3)`,
      [projectsFolderId, SPACE, now],
    );
    const area = await new ProjectResearchAreaService(pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const folder = await pool.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM note_collections WHERE id=$1 AND space_id=$2`, [area.notes_collection_id, SPACE],
    );
    expect(folder.rows[0]?.parent_id).toBe(projectsFolderId);
  });

  it("falls back to a root-level folder when no 'Projects' folder has been seeded (e.g. it was renamed or deleted)", async () => {
    if (!available || !pool) return;
    const area = await new ProjectResearchAreaService(pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const folder = await pool.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM note_collections WHERE id=$1 AND space_id=$2`, [area.notes_collection_id, SPACE],
    );
    expect(folder.rows[0]?.parent_id).toBeNull();
  });

  it("does not initialize a area after its Project is archived", async () => {
    if (!available || !pool) return;
    await pool.query(`UPDATE projects SET status='archived',archived_at=now() WHERE id=$1 AND space_id=$2`, [PROJECT, SPACE]);
    await expect(
      new ProjectResearchAreaService(pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM note_collections WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    )).rows[0]?.count).toBe("0");
  });

  it("applies AI block ops without touching other blocks and supports rollback from the revision history", async () => {
    if (!available || !pool) return; const service = new ProjectResearchAreaService(pool); const identity = { spaceId: SPACE, userId: USER };
    const area = await service.initializeArea(identity, PROJECT);
    const understandingId = area.notes[0]!.id;
    const knowledge = new PgKnowledgeRepository(pool);
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
    const written = await writeNote(pool, {
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
    if (!available || !pool) return; const now = new Date().toISOString(); const item = randomUUID(); const corpus = randomUUID();
    await pool.query(`INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES ($1,$2,$3,'space_shared','feed_entry','Paper',$4,$4,'excerpt_saved','summary_only',$4,$4)`, [item, SPACE, USER, now]);
    await pool.query(`INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at) VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`, [corpus, SPACE, PROJECT, item, now]);
    await seedCorpusSourceProvenance(corpus, item, now);
    const service = new ProjectResearchAreaService(pool);
    const first = await service.materializeEvidenceCardsFromDeepAnalysis({ spaceId: SPACE, projectId: PROJECT, runId: randomUUID(), summaries: [{ source_item_id: item, summary_markdown: "WHY: Relevant\nHOW: Experiment\nWHAT: Result" }] });
    expect(first).toBe(1);
    await service.upsertEvidenceCard({ spaceId: SPACE, userId: USER }, PROJECT, item, { why_md: "My reason", how_md: "My method", what_md: "My result" });
    const second = await service.materializeEvidenceCardsFromDeepAnalysis({ spaceId: SPACE, projectId: PROJECT, runId: randomUUID(), summaries: [{ source_item_id: item, summary_markdown: "WHY: Replaced\nHOW: Replaced\nWHAT: Replaced" }] });
    expect(second).toBe(0);
    expect((await pool.query(`SELECT why_md,edited_by_user FROM research_evidence_cards WHERE source_item_id=$1`, [item])).rows[0]).toEqual({ why_md: "My reason", edited_by_user: true });
  });

  it("materializes every monitoring stance as an Evidence Signal and only escalates material comparisons", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString(); const workflow = randomUUID(); const operation = randomUUID();
    const supporting = randomUUID(); const contradicting = randomUUID();
    await new ProjectResearchAreaService(pool).initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    const thread = await new InquiryThreadService(pool).createThread(
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
    await insertResearchWorkflowFixture(pool, {
      id: workflow, spaceId: SPACE, projectId: PROJECT, startedByUserId: USER,
      primaryThreadId: String(thread.id), state: {
        research_question: "Does the effect replicate?",
        thread_scope: threadScope,
      }, now,
    });
    await pool.query(
      `INSERT INTO project_operations (
         id, space_id, project_id, kind, title, status, progress_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'research', 'Monitoring scan', 'active',
                 '{}'::jsonb, $4, $4)`,
      [operation, SPACE, PROJECT, now],
    );
    for (const [item, title] of [[supporting, "Supporting paper"], [contradicting, "Contradicting paper"]]) {
      await pool.query(
        `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared','feed_entry',$4,$5,$5,'excerpt_saved','summary_only',$5,$5)`,
        [item, SPACE, USER, title, now],
      );
      const corpusItemId = randomUUID();
      await pool.query(
        `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
        [corpusItemId, SPACE, PROJECT, item, now],
      );
      await seedCorpusSourceProvenance(corpusItemId, item, now);
    }
    await pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,2,2,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, workflow, operation, `operation:${operation}`, now],
    );
    const comparisonRun = randomUUID();
    const comparisons = parseMonitorComparisons({ comparisons: [
      { source_item_id: supporting, stance: "supports", detail: "Replicates the current effect.", affected_sections: ["understanding"] },
      { source_item_id: contradicting, stance: "contradicts", detail: "Finds no effect under stronger controls.", affected_sections: ["understanding", "questions"] },
    ] }, [supporting, contradicting]);
    const comparisonService = new ProjectResearchMonitorComparisonService(pool);
    const result = await comparisonService.persistComparisons({
      spaceId: SPACE, projectId: PROJECT, workflowId: workflow, operationId: operation, runId: comparisonRun, comparisons,
      researchQuestion: "Does the effect replicate?", threadScope, instructedByUserId: USER,
    });
    expect(result.signalIds).toHaveLength(2);
    expect((await pool.query(`SELECT supports_count,contradicts_count,new_direction_count FROM research_scan_summaries WHERE operation_id=$1`, [operation])).rows[0])
      .toEqual({ supports_count: 1, contradicts_count: 1, new_direction_count: 0 });
    // The notebook is untouched — monitoring no longer co-edits it directly.
    // Resolved by role, and refs read from the note's latest revision: the
    // title binding and `notes.refs_json` are both gone (NA, N8).
    const section = (await pool.query(
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

    const signals = (await pool.query<{ classification: string; is_material: boolean; status: string; thread_id: string }>(
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
    const candidate = (await pool.query<{ candidate_kind: string; status: string }>(
      `SELECT candidate_kind,status FROM inquiry_signal_candidates WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    )).rows[0];
    expect(candidate).toEqual({ candidate_kind: "contradiction", status: "pending" });

    const supportOnlyOperation = randomUUID();
    await pool.query(
      `INSERT INTO project_operations (
         id, space_id, project_id, kind, title, status, progress_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'research', 'Support-only scan', 'active',
                 '{}'::jsonb, $4, $4)`,
      [supportOnlyOperation, SPACE, PROJECT, now],
    );
    await pool.query(
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
    expect((await pool.query(`SELECT n.version FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id WHERE so.primary_project_id=$1 AND so.title='Current understanding'`, [PROJECT])).rows[0]).toEqual({ version: 1 });
    expect((await pool.query(`SELECT count(*)::int AS count FROM inquiry_evidence_signals WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT])).rows[0]?.count).toBe(2);
  });

  it("deduplicates cited-DOI integrity alerts and creates review work", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString(); const workflow = randomUUID(); const sourceItem = randomUUID();
    const service = new ProjectResearchAreaService(pool);
    const area = await service.initializeArea({ spaceId: SPACE, userId: USER }, PROJECT);
    await insertResearchWorkflowFixture(pool, {
      id: workflow, spaceId: SPACE, projectId: PROJECT, startedByUserId: USER,
      currentStage: "monitoring", now,
    });
    await pool.query(
      `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,metadata_json,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
       VALUES ($1,$2,$3,'space_shared','feed_entry','Cited paper',$4::jsonb,$5,$5,'excerpt_saved','summary_only',$5,$5)`,
      [sourceItem, SPACE, USER, JSON.stringify({ doi: "10.1000/original" }), now],
    );
    const corpusItemId = randomUUID();
    await pool.query(
      `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'reference','active','relevant',true,'read',$5,$5)`,
      [corpusItemId, SPACE, PROJECT, sourceItem, now],
    );
    await seedCorpusSourceProvenance(corpusItemId, sourceItem, now);
    const understandingId = area.notes[0]!.id;
    // Refs live on `note_revisions` now (N8), and the only writer is
    // `writeNote` — so the fixture goes through it rather than reaching past
    // it into a column, which is what let the old copy drift in the first place.
    await writeNote(pool, {
      spaceId: SPACE,
      noteId: understandingId,
      content: { kind: "doc", doc: { type: "doc", content: [] } },
      source: "ai_adhoc",
      refs: [sourceItem],
    });
    const monitor = new ProjectResearchIntegrityMonitorService(pool, async () => ({ message: { "updated-by": [
      { DOI: "10.1000/retraction", type: "retraction", source: "retraction-watch" },
    ] } }));
    const first = await monitor.check({ spaceId: SPACE, projectId: PROJECT, workflowId: workflow, userId: USER });
    const second = await monitor.check({ spaceId: SPACE, projectId: PROJECT, workflowId: workflow, userId: USER });
    expect(first.alerts).toHaveLength(1); expect(first.checkpointId).toBeTruthy(); expect(first.checklistItemIds).toHaveLength(1);
    expect(second.alerts).toHaveLength(0);
    expect(Number((await pool.query(`SELECT count(*) AS count FROM research_integrity_alerts WHERE project_id=$1`, [PROJECT])).rows[0]?.count)).toBe(1);
    expect((await pool.query(`SELECT text,origin FROM research_checklist_items WHERE project_id=$1`, [PROJECT])).rows[0]).toMatchObject({ origin: "agent" });
    expect((await pool.query(`SELECT integrity_alerts_json FROM research_scan_summaries WHERE workflow_id=$1`, [workflow])).rows[0]?.integrity_alerts_json).toMatchObject([{ event_type: "retraction", doi: "10.1000/original" }]);
    expect((await pool.query(`SELECT checkpoint_type,status FROM project_research_checkpoints WHERE workflow_id=$1`, [workflow])).rows[0]).toEqual({ checkpoint_type: "integrity_gate", status: "pending" });
    expect(await enqueueDueResearchIntegrityChecks(pool, new Date("2026-07-19T12:00:00.000Z"))).toBe(1);
    expect(await enqueueDueResearchIntegrityChecks(pool, new Date("2026-07-19T13:00:00.000Z"))).toBe(0);
  });

  it("askAi queues an edit-mode run against the contracted section and counts against the shared daily budget", async () => {
    if (!available || !pool || !config) return;
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(pool, config);
    await service.initializeArea(identity, PROJECT);

    const edited = await service.askAi(identity, PROJECT, {
      prompt: "Rewrite the current understanding.",
      section_key: "understanding",
      execution: { model_provider_id: PROVIDER },
    });
    expect(edited).toMatchObject({ daily_limit: 20, daily_used: 1 });
    const editRun = (await pool.query<{ capability_id: string; contract_snapshot_json: { workflow_input_json?: { research_adhoc?: unknown } } }>(
      `SELECT capability_id,contract_snapshot_json FROM runs WHERE id=$1`, [edited.run_id],
    )).rows[0];
    expect(editRun?.capability_id).toBe("research.adhoc_analyze");
    expect(editRun?.contract_snapshot_json.workflow_input_json?.research_adhoc).toBeTruthy();
  });

  it("notebookChat persists both turns to one reusable session and shares askAi's daily budget", async () => {
    if (!available || !pool || !config) return;
    // The provider is unreachable in tests; a fast, deterministic failure lets
    // us assert the graceful-failure path (message persistence, session
    // reuse, shared budget) without depending on the full structured-output
    // adapter pipeline — success-path notebook writes are already covered via
    // applyOpsWithConflictFallback in projectResearchSynthesisReconcileDb.test.ts.
    __setProviderHttpClientForTests({ fetch: async () => new Response("{}", { status: 500 }) });
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(pool, config);
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

    const second = await service.notebookChat(identity, PROJECT, {
      message: "Follow-up question.",
      session_id: sessionId,
      execution: { model_provider_id: PROVIDER },
    });
    // Reuses the same session (multi-turn) and keeps drawing from askAi's
    // shared 20/project/day pool.
    expect(second.session_id).toBe(sessionId);
    expect(second.daily_used).toBe(2);

    const messages = (await pool.query<{ role: string; content: string }>(
      `SELECT role,content FROM messages WHERE session_id=$1 ORDER BY created_at ASC`, [sessionId],
    )).rows;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[0]?.content).toBe("What is the current understanding?");
    expect(messages[2]?.content).toBe("Follow-up question.");
  });

  it("notebookChat rejects a session_id that belongs to a different project", async () => {
    if (!available || !pool || !config) return;
    const identity = { spaceId: SPACE, userId: USER };
    const service = new ProjectResearchAreaService(pool, config);
    await service.initializeArea(identity, PROJECT);
    const otherProject = randomUUID();
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Other','active',$4,$4)`, [otherProject, SPACE, USER, now]);
    const otherSession = await pool.query<{ id: string }>(
      `INSERT INTO sessions (id,space_id,user_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5) RETURNING id`,
      [randomUUID(), SPACE, USER, otherProject, now],
    );
    await expect(service.notebookChat(identity, PROJECT, {
      message: "Hello", session_id: otherSession.rows[0]!.id, execution: { model_provider_id: PROVIDER },
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});
