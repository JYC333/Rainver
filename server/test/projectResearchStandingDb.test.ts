import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import {
  ProjectResearchStandingComparisonService,
  STANDING_COMPARISON_DAILY_RUN_LIMIT,
  STANDING_COMPARISON_JOB_TYPE,
} from "../src/modules/projectResearch/standingComparisonService";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { ProjectSourceBindingService } from "../src/modules/projects/projectSourceBindingService";
import { materializeProjectSourceItemLinks } from "../src/modules/projects/projectSourceRoutingService";
import { syncProjectCorpusForSourceItem } from "../src/modules/projects/corpusRepository";
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository";
import { ProjectResearchAreaService } from "../src/modules/projectResearch/areaService";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// R5's standing service deliberately has no Workflow or Inquiry Thread
// prerequisite. These tests keep PostgreSQL, Project ACLs, durable Jobs, Run
// records, advice materialization, and the explicit user action real; only the
// model-produced terminal output is seeded at the Run boundary.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const identity = { spaceId: SPACE, userId: USER };


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_research_standing_advice", "project_research_standing_batches", "research_scan_summaries", "research_evidence_cards", "project_corpus_item_sources", "project_corpus_items", "source_items", "jobs", "runs", "note_revisions", "note_collection_items", "note_collections", "notes", "space_objects", "project_source_item_links", "project_source_bindings", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "agent_versions", "agents", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','team',$2,$2)`, [SPACE, now]);
  await db.pool.query(
    `INSERT INTO users (id,display_name,status,created_at,updated_at)
     VALUES ($1,'Owner','active',$3,$3),($2,'Viewer','active',$3,$3)`,
    [USER, VIEWER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$3,$4,'owner','active',$5,$5),($2,$3,$6,'member','active',$5,$5)`,
    [randomUUID(), randomUUID(), SPACE, USER, now, VIEWER],
  );
  await db.pool.query(
    `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
     VALUES ($1,$2,$3,'Standing research','active',$4,$4)`,
    [PROJECT, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`,
    [randomUUID(), SPACE, PROJECT, VIEWER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,created_at,updated_at)
     VALUES ($1,$2,$3,'Research agent','active',NULL,'space_shared',$4,$4)`,
    [AGENT, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id,agent_id,space_id,version_label,system_prompt,model_config_json,runtime_config_json,
       context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,runtime_policy_json,created_at
     ) VALUES ($1,$2,$3,'v1','Test','{}','{}','{}','{}','[]','{}','{}',$4)`,
    [VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, VERSION]);
});

async function seedBaseline(): Promise<void> {
  const knowledge = new PgKnowledgeRepository(db.pool);
  const note = await knowledge.createNote(identity, {
    title: "Current understanding",
    primary_project_id: PROJECT,
    plain_text: "The present project baseline.",
  }) as { id: string };
  await knowledge.updateNote(identity, note.id, { project_role: "understanding" });
}

async function seedSourceInCorpus(): Promise<string> {
  const now = new Date().toISOString();
  const sourceItemId = randomUUID();
  const corpusItemId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_items (
       id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,
       content_state,retention_policy,created_at,updated_at
     ) VALUES ($1,$2,$3,'space_shared','external_url','Unexpected finding','A new direction.',$4,$4,
       'excerpt_saved','summary_only',$4,$4)`,
    [sourceItemId, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO project_corpus_items (
       id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
    [corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
  await db.pool.query(
    `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
  return sourceItemId;
}

async function seedRun(input: { status: string; output?: unknown; createdAt?: Date }): Promise<string> {
  const id = randomUUID();
  const now = (input.createdAt ?? new Date()).toISOString();
  await db.pool.query(
    `INSERT INTO runs (
       id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,adapter_type,
       instructed_by_user_id,owner_user_id,project_id,capability_id,contract_snapshot_json,output_json,
       created_at,updated_at,started_at,ended_at
     ) VALUES ($1,$2,$3,$4,'agent','system',$5,'live','model_api',$6,$6,$7,
       'research.monitor_compare',$8::jsonb,$9::jsonb,$10,$10,$10,$10)`,
    [id, SPACE, AGENT, VERSION, input.status, USER, PROJECT,
      JSON.stringify({ workflow_input_json: { project_research_standing: { test: true } } }),
      JSON.stringify(input.output ?? null), now],
  );
  return id;
}

async function seedSourceChannel(kind: "rss" | "web_page"): Promise<string> {
  const connectorId = randomUUID();
  const providerId = randomUUID();
  const mappingId = randomUUID();
  const connectionId = randomUUID();
  const channelId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_connectors (
       id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at
     ) VALUES ($1,$2,$3,'external_feed','pull','active','{}'::jsonb,$4,$4)`,
    [connectorId, kind, kind === "rss" ? "RSS" : "Web page", now],
  );
  await db.pool.query(
    `INSERT INTO source_providers (
       id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at
     ) VALUES ($1,$2,$3,'generic','general','active','{}'::jsonb,$4,$4)`,
    [providerId, `generic_${kind}`, kind === "rss" ? "RSS" : "Web page", now],
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (
       id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at
     ) VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, providerId, connectorId, now],
  );
  await db.pool.query(
    `INSERT INTO source_connections (
       id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,
       consent_json,policy_json,config_json,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,'active','reference_only','normal',$6::jsonb,$7::jsonb,'{}'::jsonb,$8,$8)`,
    [connectionId, SPACE, mappingId, USER, `${kind} source`, JSON.stringify({
      schema_version: 1, owner_user_id: USER, allowed_reader_user_ids: [], allowed_agent_ids: [],
      allow_space_admins: true, allow_local_provider_egress: true, allow_external_model_egress: true,
    }), JSON.stringify({ schema_version: 1, source_egress_class: "external_provider_allowed" }), now],
  );
  await db.pool.query(
    `INSERT INTO source_channels (
       id,space_id,source_connection_id,created_by_user_id,name,channel_type,endpoint_url,
       query_json,provider_query_json,query_fingerprint,status,fetch_frequency,schedule_rule_json,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,'feed',$6,'{}'::jsonb,'{}'::jsonb,$1,'active','daily',
       '{"frequency":"daily","hour":0,"minute":0}'::jsonb,$7,$7)`,
    [channelId, SPACE, connectionId, USER, `${kind} channel`, `https://example.test/${kind}`, now],
  );
  await db.pool.query(
    `INSERT INTO source_channel_user_subscriptions (
       id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,
    [randomUUID(), SPACE, channelId, USER, now],
  );
  return channelId;
}

describe("project research standing comparison (real Postgres)", () => {
  it("runs the non-academic source-to-standing-to-focus evidence workflow", async () => {
    if (!db.available) return;
    const rssChannelId = await seedSourceChannel("rss");
    const webChannelId = await seedSourceChannel("web_page");
    const bindings = new ProjectSourceBindingService(db.pool);
    const rssBinding = await bindings.createBinding(identity, {
      project_id: PROJECT,
      source_channel_id: rssChannelId,
      standing_comparison_enabled: true,
    }) as { extraction_profile: { key: string } };
    const webBinding = await bindings.createBinding(identity, {
      project_id: PROJECT,
      source_channel_id: webChannelId,
      standing_comparison_enabled: true,
    }) as { extraction_profile: { key: string } };
    expect([rssBinding.extraction_profile.key, webBinding.extraction_profile.key])
      .toEqual(["generic_document_v1", "generic_document_v1"]);
    expect((await db.pool.query<{ project_role: string }>(
      `SELECT project_role FROM notes WHERE role_project_id=$1 ORDER BY project_role`,
      [PROJECT],
    )).rows.map(row => row.project_role)).toEqual(["experiments", "ideas", "questions", "understanding"]);

    const sourceItemId = randomUUID();
    const now = new Date().toISOString();
    const connection = await db.pool.query<{ source_connection_id: string }>(
      `SELECT source_connection_id FROM source_channels WHERE id=$1`,
      [webChannelId],
    );
    await db.pool.query(
      `INSERT INTO source_items (
         id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,canonical_uri,
         source_domain,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,metadata_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'space_shared',$4,'external_url','General policy update',$5,$5,
         'example.test','A non-academic change worth investigating.',$6,$6,'excerpt_saved','summary_only','{}'::jsonb,$6,$6)`,
      [sourceItemId, SPACE, USER, connection.rows[0]!.source_connection_id, "https://example.test/policy", now],
    );
    await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId });
    const batch = await db.pool.query<{ id: string }>(
      `SELECT id FROM project_research_standing_batches WHERE project_id=$1 AND status='pending'`,
      [PROJECT],
    );
    expect(batch.rows).toHaveLength(1);

    await db.pool.query(
      `UPDATE project_corpus_items SET triage_status='relevant',triage_confirmed_by_user=true
        WHERE project_id=$1 AND source_item_id=$2`,
      [PROJECT, sourceItemId],
    );
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId });
    const object = await db.pool.query<{ object_id: string; source_type: string }>(
      `SELECT pci.object_id,s.source_type FROM project_corpus_items pci
         JOIN sources s ON s.object_id=pci.object_id AND s.space_id=pci.space_id
        WHERE pci.project_id=$1 AND pci.source_item_id IS NULL`,
      [PROJECT],
    );
    expect(object.rows[0]).toMatchObject({ source_type: "webpage" });

    const detail = "Investigate how the policy update changes the current implementation.";
    const runId = await seedRun({
      status: "succeeded",
      output: { comparisons: [{ source_item_id: sourceItemId, stance: "new_direction", detail, affected_sections: ["questions"] }] },
    });
    await db.pool.query(
      `UPDATE project_research_standing_batches SET status='running',run_id=$2 WHERE id=$1`,
      [batch.rows[0]!.id, runId],
    );
    await new ProjectResearchStandingComparisonService(db.pool).reconcileRun(SPACE, runId);
    const advice = await db.pool.query<{ id: string }>(
      `SELECT id FROM project_research_standing_advice WHERE batch_id=$1`,
      [batch.rows[0]!.id],
    );
    const action = await new ProjectResearchStandingComparisonService(db.pool).actionAdvice(identity, PROJECT, advice.rows[0]!.id) as {
      thread: { id: string };
    };
    const workflowId = randomUUID();
    await insertResearchWorkflowFixture(db.pool, {
      id: workflowId,
      spaceId: SPACE,
      projectId: PROJECT,
      startedByUserId: USER,
      primaryThreadId: action.thread.id,
      status: "completed",
      currentStage: "completed",
      state: { research_question: detail },
    });
    const matrix = await new ProjectResearchRepository(db.pool).getEvidenceMatrix(identity, PROJECT);
    expect(matrix).toContainEqual(expect.objectContaining({
      object_id: object.rows[0]!.object_id,
      title: "General policy update",
      academic: null,
    }));
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM academic_papers`,
    )).rows[0]!.count).toBe(0);
  });

  it("batches workflow-free inflow once and reports an explicit missing baseline", async () => {
    if (!db.available) return;
    const service = new ProjectResearchStandingComparisonService(db.pool);
    const first = randomUUID();
    const second = randomUUID();

    const batchId = await service.collect({ spaceId: SPACE, projectId: PROJECT, sourceItemId: first });
    expect(await service.collect({ spaceId: SPACE, projectId: PROJECT, sourceItemId: second })).toBe(batchId);
    expect(await service.collect({ spaceId: SPACE, projectId: PROJECT, sourceItemId: first })).toBe(batchId);

    const batch = (await db.pool.query<{ workflow_count: number; source_item_ids_json: string[] }>(
      `SELECT (SELECT count(*)::int FROM project_research_workflows WHERE project_id=$1) AS workflow_count,
              source_item_ids_json FROM project_research_standing_batches WHERE id=$2`,
      [PROJECT, batchId],
    )).rows[0]!;
    expect(batch).toEqual({ workflow_count: 0, source_item_ids_json: [first, second] });
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE job_type=$1 AND payload_json->>'batch_id'=$2`,
      [STANDING_COMPARISON_JOB_TYPE, batchId],
    )).rows[0]?.count).toBe(1);

    await expect(service.dispatchBatch(SPACE, batchId)).resolves.toMatchObject({
      status: "blocked_baseline",
      missing_baseline_role: "understanding",
    });

    await new ProjectResearchAreaService(db.pool).initializeArea(identity, PROJECT);
    await expect(service.retryBatch(identity, PROJECT, batchId)).resolves.toMatchObject({
      status: "pending",
      missing_baseline_role: null,
    });
    expect((await db.pool.query<{ status: string; count: number }>(
      `SELECT b.status,(SELECT count(*)::int FROM jobs j
          WHERE j.job_type=$2 AND j.payload_json->>'batch_id'=b.id) AS count
         FROM project_research_standing_batches b WHERE b.id=$1`,
      [batchId, STANDING_COMPARISON_JOB_TYPE],
    )).rows[0]).toEqual({ status: "pending", count: 2 });
  });

  it("enforces the daily Project budget before attempting another execution", async () => {
    if (!db.available) return;
    await seedBaseline();
    const service = new ProjectResearchStandingComparisonService(db.pool);
    const batchId = await service.collect({ spaceId: SPACE, projectId: PROJECT, sourceItemId: randomUUID() });
    for (let index = 0; index < STANDING_COMPARISON_DAILY_RUN_LIMIT; index += 1) {
      await seedRun({ status: "succeeded" });
    }

    await expect(service.dispatchBatch(SPACE, batchId)).resolves.toMatchObject({
      status: "budget_exhausted",
      daily_used: STANDING_COMPARISON_DAILY_RUN_LIMIT,
      daily_limit: STANDING_COMPARISON_DAILY_RUN_LIMIT,
    });
  });

  it("turns a new direction into advice that creates one Thread when actioned repeatedly", async () => {
    if (!db.available) return;
    const sourceItemId = await seedSourceInCorpus();
    const detail = "Investigate whether the effect reverses in a new setting.";
    const runId = await seedRun({
      status: "succeeded",
      output: { comparisons: [{ source_item_id: sourceItemId, stance: "new_direction", detail, affected_sections: ["questions"] }] },
    });
    const batchId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_research_standing_batches (
         id,space_id,project_id,status,source_item_ids_json,window_started_at,ready_at,run_id,created_at,updated_at
       ) VALUES ($1,$2,$3,'running',$4::jsonb,$5,$5,$6,$5,$5)`,
      [batchId, SPACE, PROJECT, JSON.stringify([sourceItemId]), now, runId],
    );

    const result = await new ProjectResearchStandingComparisonService(db.pool).reconcileRun(SPACE, runId);
    expect(result).toMatchObject({ status: "completed", comparison_count: 1 });
    expect((await db.pool.query(`SELECT stance,comparison_detail FROM research_evidence_cards WHERE source_item_id=$1`, [sourceItemId])).rows[0])
      .toEqual({ stance: "new_direction", comparison_detail: detail });
    const advice = (await db.pool.query<{ id: string; action_id: string; action_input_json: Record<string, unknown>; idempotency_key: string }>(
      `SELECT id,action_id,action_input_json,idempotency_key FROM project_research_standing_advice WHERE source_item_id=$1`,
      [sourceItemId],
    )).rows[0]!;
    expect(advice.action_id).toBe("source.raise_as_question");
    expect(advice.action_input_json).toEqual({
      kind: "question",
      statement: detail,
      producer_idempotency_key: advice.idempotency_key,
    });
    expect((await db.pool.query(`SELECT workflow_id FROM research_scan_summaries WHERE scan_key=$1`, [`standing:${batchId}`])).rows[0])
      .toEqual({ workflow_id: null });
    expect((await db.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM inquiry_threads WHERE project_id=$1`, [PROJECT])).rows[0]?.count).toBe(0);

    const standing = new ProjectResearchStandingComparisonService(db.pool);
    const first = await standing.actionAdvice(identity, PROJECT, advice.id);
    const second = await standing.actionAdvice(identity, PROJECT, advice.id);
    expect(first).toMatchObject({ advice: { status: "actioned" }, thread: { statement: detail } });
    expect(second).toMatchObject({ advice: { status: "actioned" }, thread: { statement: detail } });
    expect((await db.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM inquiry_threads WHERE project_id=$1`, [PROJECT])).rows[0]?.count).toBe(1);
  });

  it("does not disclose standing advice for a SourceItem the Project viewer cannot read", async () => {
    if (!db.available) return;
    const sourceItemId = await seedSourceInCorpus();
    const detail = "Private direction from the source owner.";
    const runId = await seedRun({
      status: "succeeded",
      output: { comparisons: [{ source_item_id: sourceItemId, stance: "new_direction", detail, affected_sections: ["questions"] }] },
    });
    const batchId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_research_standing_batches (
         id,space_id,project_id,status,source_item_ids_json,window_started_at,ready_at,run_id,created_at,updated_at
       ) VALUES ($1,$2,$3,'running',$4::jsonb,$5,$5,$6,$5,$5)`,
      [batchId, SPACE, PROJECT, JSON.stringify([sourceItemId]), now, runId],
    );
    const standing = new ProjectResearchStandingComparisonService(db.pool);
    await standing.reconcileRun(SPACE, runId);
    await db.pool.query(`UPDATE source_items SET visibility='private' WHERE id=$1 AND space_id=$2`, [sourceItemId, SPACE]);

    expect((await standing.status(identity, PROJECT) as { advice: unknown[] }).advice).toHaveLength(1);
    expect((await standing.status({ spaceId: SPACE, userId: VIEWER }, PROJECT) as { advice: unknown[] }).advice).toEqual([]);
  });
});
