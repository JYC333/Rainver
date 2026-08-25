import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import {
  PgSourcePostProcessingRepository,
  SOURCE_POST_PROCESSING_TASK_TYPE,
  normalizeActions,
  normalizeInputConfig,
  normalizeTriggerConfig,
} from "../src/modules/sources/postProcessing/repository";
import { withQueryableTransaction } from "../src/modules/routeUtils/common";
import type { SourceConnectionRow } from "../src/modules/sources/sourceRepositoryRows";
import type { ServerConfig } from "../src/config";
import { ProjectResearchInitialIntakeCoordinator } from "../src/modules/projectResearch/pipeline/initialIntakeCoordinator";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const AGENT = "77777777-7777-4777-8777-777777777777";
const AGENT_VERSION = "88888888-8888-4888-8888-888888888888";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["activity_records", "artifacts", "source_post_processing_item_decisions", "source_post_processing_runs", "source_post_processing_rules", "jobs", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "extracted_evidence", "source_channel_item_links", "source_channel_user_subscriptions", "source_channels", "source_items", "scheduler_tasks", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "agent_runtime_profiles", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`,
    [SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,'Owner','active',$2,$2)`,
    [OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Reusable Source Agent','active',NULL,$4,$4,'space_shared')`,
    [AGENT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1','Summarize source','{}'::jsonb,'{"adapter_type":"model_api"}'::jsonb,
       '{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, AGENT_VERSION]);
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, model_provider_id, model_name,
       runtime_config_json, runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES ($1,$2,$3,'Default','model_api',NULL,NULL,
       '{"adapter_type":"model_api"}'::jsonb,'{"default_adapter_type":"model_api"}'::jsonb,true,true,$4,$4)`,
    [randomUUID(), SPACE, AGENT, now],
  );
  await db.pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ($1,'rss','RSS','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'generic_rss','RSS','generic','feed','active','{}'::jsonb,$2,$2)`,
    [randomUUID(), now],
  );
  const provider = await db.pool.query<{ id: string }>(`SELECT id FROM source_providers WHERE provider_key='generic_rss'`);
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [randomUUID(), provider.rows[0]!.id, CONNECTOR, now],
  );
  const mapping = await db.pool.query<{ id: string }>(`SELECT id FROM source_provider_connectors WHERE connector_id=$1`, [CONNECTOR]);
  await db.pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'arXiv','active','reference_only','normal','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
    [CONNECTION, SPACE, mapping.rows[0]!.id, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_channels (
       id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
       query_json, provider_query_json, query_fingerprint, status, fetch_frequency, schedule_rule_json, created_at, updated_at
     ) VALUES ($1,$2,$1,$3,'arXiv Channel','feed','https://example.org/rss','{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,$4,$4)`,
    [CONNECTION, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_channel_user_subscriptions (
       id, space_id, source_channel_id, user_id, status,
       library_enabled, digest_enabled, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,
    [randomUUID(), SPACE, CONNECTION, OWNER, now],
  );
});

function repo(): PgSourcePostProcessingRepository {
  return new PgSourcePostProcessingRepository(db.pool);
}

class FakePostProcessingDb {
  calls: Array<{ sql: string; params: unknown[] }> = [];

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    return { rows: [{ id: "job-1", source_item_id: "item-1" } as T] };
  }
}

function sourceConnection(overrides: Partial<SourceConnectionRow> = {}): SourceConnectionRow {
  const now = new Date().toISOString();
  return {
    id: CONNECTION,
    space_id: SPACE,
    project_id: null,
    owner_user_id: OWNER,
    credential_id: null,
    visibility: "space_shared",
    access_level: "full",
    name: "arXiv",
    status: "active",
    capture_policy: "extract_text",
    trust_level: "normal",
    topic_hints_json: [],
    consent_json: {},
    policy_json: {},
    config_json: {},
    handler_kind: "rss",
    active_handler_version_id: null,
    active_recipe_version_id: null,
    repair_status: "ok",
    last_handler_run_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function seedItem(title: string, createdAt: string): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type,
       title, source_uri, excerpt, first_seen_at, last_seen_at,
       content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'external_url',$5,$7,'Paper abstract',
       $6,$6,'excerpt_saved','summary_only',$6,$6)`,
    [id, SPACE, OWNER, CONNECTION, title, createdAt, `https://example.org/paper/${id}`],
  );
  await db.pool.query(
    `INSERT INTO source_channel_item_links (
       id, space_id, source_channel_id, source_item_id, status, matched_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
    [randomUUID(), SPACE, CONNECTION, id, createdAt],
  );
  return id;
}

async function seedEvidence(itemId: string, title: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO extracted_evidence (
       id, space_id, owner_user_id, visibility, source_item_id, source_object_type, source_object_id,
       evidence_type, title, content_excerpt, trust_level, extraction_method,
       confidence, status, metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'source_item',$4,'excerpt',$5,'Important excerpt',
       'normal','manual',0.8,'candidate','{}'::jsonb,$6,$6)`,
    [id, SPACE, OWNER, itemId, title, now],
  );
  return id;
}

describe("source post-processing repository queue helpers", () => {
  it("allows extracted text queueing for items that only have saved snapshots", async () => {
    const db = new FakePostProcessingDb();
    await new PgSourcePostProcessingRepository(db as never).queueFullTextExtractionForItems({
      spaceId: SPACE,
      connection: sourceConnection(),
      itemIds: ["item-1"],
      metadata: { source: "test" },
    });

    const sql = db.calls[0]?.sql ?? "";
    expect(sql).toContain("ii.content_state <> 'content_saved'");
    expect(sql).not.toContain("snapshot_saved");
  });

  it("appends source post-processing follow-ups instead of overwriting extraction metadata", async () => {
    const db = new FakePostProcessingDb();
    await new PgSourcePostProcessingRepository(db as never).queueFullTextExtractionForItems({
      spaceId: SPACE,
      connection: sourceConnection(),
      itemIds: ["item-1"],
      metadata: {
        source: "source_post_processing",
        source_post_processing_followups: [{
          phase: "deep_analysis",
          source_post_processing_rule_id: "rule-1",
          source_post_processing_run_id: "run-1",
        }],
      },
    });

    const sql = db.calls[0]?.sql ?? "";
    expect(sql).toContain("source_post_processing_followups");
    expect(sql).toContain("jsonb_build_object");
    expect(sql).toContain("|| COALESCE");
  });
});

describe("source post-processing repository (real Postgres)", () => {
  it("reuses a Thread-scoped Auto Research rule when a channel name has trailing whitespace", async () => {
    if (!db.available) return;
    const monitorName = `${"memory augmented research ".repeat(12).slice(0, 179)} `;
    const threadScope = [{ thread_id: "12345678-1234-4123-8123-123456789abc", version: 1, kind: "question" as const, statement: "How should agents remember?" }];
    const ruleName = `Auto Research 12345678: ${monitorName}`.trim();
    await db.pool.query(`UPDATE source_channels SET name=$3 WHERE id=$1 AND space_id=$2`, [CONNECTION, SPACE, monitorName]);
    const existing = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: PROJECT,
      name: ruleName,
      triggerType: "items_materialized",
      triggerConfig: normalizeTriggerConfig({ min_new_items: 1 }, "items_materialized"),
      inputConfig: normalizeInputConfig({ item_limit: 10 }),
      actions: normalizeActions({ batch_digest: true }),
      createdByUserId: OWNER,
    });

    const reused = await withQueryableTransaction(db.pool, (db) =>
      new ProjectResearchInitialIntakeCoordinator(db, {} as ServerConfig).ensurePostProcessingRule(
        { spaceId: SPACE, userId: OWNER },
        PROJECT,
        CONNECTION,
        {
          researchQuestion: "How should agents remember?",
          threadScope,
          agentId: AGENT,
          runtimeProfileId: "runtime-profile",
          researchScope: { sub_questions: [], in: [], out: [], must_have: [], nice_to_have: [] },
        },
        monitorName,
        "arxiv",
      ));

    expect(reused).toMatchObject({ id: existing.id, name: ruleName });
    const count = await db.pool.query<{ count: string }>(
      `SELECT count(*) FROM source_post_processing_rules
        WHERE space_id=$1 AND project_id=$2 AND source_channel_id=$3 AND status <> 'archived'`,
      [SPACE, PROJECT, CONNECTION],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it("joins a caller-owned transaction when creating a rule", async () => {
    if (!db.available) return;
    const created = await withQueryableTransaction(db.pool, (db) =>
      new PgSourcePostProcessingRepository(db).createRule({
        spaceId: SPACE,
        sourceChannelId: CONNECTION,
        agentId: AGENT,
        projectId: PROJECT,
        name: "Transactional digest",
        triggerType: "items_materialized",
        triggerConfig: normalizeTriggerConfig({ min_new_items: 1 }, "items_materialized"),
        inputConfig: normalizeInputConfig({ item_limit: 10 }),
        actions: normalizeActions({ batch_digest: true }),
        createdByUserId: OWNER,
      }),
    );

    expect(created).toMatchObject({
      source_channel_id: CONNECTION,
      project_id: PROJECT,
      name: "Transactional digest",
      status: "active",
    });
  });

  it("creates, lists, updates, and archives source-level rules", async () => {
    if (!db.available) return;
    const created = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: PROJECT,
      name: "Daily digest",
      triggerType: "items_materialized",
      triggerConfig: normalizeTriggerConfig({ min_new_items: 2, cooldown_seconds: 60 }, "items_materialized"),
      inputConfig: normalizeInputConfig({ item_limit: 10, include_evidence: false }),
      actions: normalizeActions({ batch_digest: true }),
      createdByUserId: OWNER,
    });

    expect(created).toMatchObject({
      source_channel_id: CONNECTION,
      agent_id: AGENT,
      project_id: PROJECT,
      status: "active",
      trigger_type: "items_materialized",
      actions_json: { batch_digest: true, create_proposals: false },
    });

    const listed = await repo().listRules(SPACE, CONNECTION);
    expect(listed.map((rule) => rule.id)).toEqual([created.id]);

    const updated = await repo().updateRule(SPACE, created.id, {
      status: "paused",
      projectId: null,
      actions: normalizeActions({ batch_digest: true, create_proposals: true }),
    });
    expect(updated.status).toBe("paused");
    expect(updated.project_id).toBeNull();
    expect(updated.actions_json.create_proposals).toBe(true);
  });

  it("collects source input by rule cursor and includes item evidence", async () => {
    if (!db.available) return;
    const first = await seedItem("Paper A", "2026-07-01T00:00:00.000Z");
    const second = await seedItem("Paper B", "2026-07-02T00:00:00.000Z");
    await seedEvidence(first, "Evidence A");

    const inputConfig = normalizeInputConfig({ item_limit: 10, include_evidence: true });
    const initial = await repo().collectInputBatch({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      viewerUserId: OWNER,
      inputConfig,
      cursor: null,
    });
    expect(initial.items.map((item) => item.id)).toEqual([first, second]);
    expect(initial.evidence.map((row) => row.source_item_id)).toEqual([first]);
    expect(initial.cursorAfter).toMatchObject({ id: second, created_at: "2026-07-02T00:00:00.000Z" });

    const next = await repo().collectInputBatch({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      viewerUserId: OWNER,
      inputConfig,
      cursor: { id: first, created_at: "2026-07-01T00:00:00.000Z" },
    });
    expect(next.items.map((item) => item.id)).toEqual([second]);
    expect(next.evidence).toHaveLength(0);
  });

  it("applies channel and reader gates to origin-backed explicit Evidence", async () => {
    if (!db.available) return;
    const itemId = await seedItem("Origin paper", "2026-07-01T00:00:00.000Z");
    const evidenceId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO extracted_evidence (
         id,space_id,owner_user_id,visibility,source_item_id,origin_source_item_id,source_object_type,
         evidence_type,title,content_excerpt,trust_level,extraction_method,status,created_at,updated_at
       ) VALUES ($1,$2,$3,'space_shared',NULL,$4,'reader_annotation','excerpt','Origin quote','Secret quote',
                 'normal','manual','candidate',$5,$5)`,
      [evidenceId, SPACE, OWNER, itemId, now],
    );
    const config = normalizeInputConfig({ window: "explicit", include_evidence: true });
    const ownerBatch = await repo().collectInputBatch({
      spaceId: SPACE, sourceChannelId: CONNECTION, viewerUserId: OWNER, inputConfig: config,
      cursor: null, explicitItemIds: [itemId], explicitEvidenceIds: [evidenceId],
    });
    expect(ownerBatch.evidence.map((row) => row.id)).toEqual([evidenceId]);

    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$1,'active',$2,$2)`, [OTHER, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, OTHER, now],
    );
    await expect(repo().collectInputBatch({
      spaceId: SPACE, sourceChannelId: CONNECTION, viewerUserId: OTHER, inputConfig: config,
      cursor: null, explicitItemIds: [], explicitEvidenceIds: [evidenceId],
    })).rejects.toMatchObject({ statusCode: 404 });

    await db.pool.query(
      `INSERT INTO source_channel_user_subscriptions (
         id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,
      [randomUUID(), SPACE, CONNECTION, OTHER, now],
    );
    await db.pool.query(`UPDATE source_items SET access_level='summary' WHERE id=$1`, [itemId]);
    await db.pool.query(`UPDATE extracted_evidence SET access_level='summary' WHERE id=$1`, [evidenceId]);
    await expect(repo().collectInputBatch({
      spaceId: SPACE, sourceChannelId: CONNECTION, viewerUserId: OTHER, inputConfig: config,
      cursor: null, explicitItemIds: [itemId], explicitEvidenceIds: [evidenceId],
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("records runs and advances per-rule cursor explicitly", async () => {
    if (!db.available) return;
    const itemId = await seedItem("Paper A", "2026-07-01T00:00:00.000Z");
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      name: "Digest",
      triggerType: "manual",
      triggerConfig: normalizeTriggerConfig(null, "manual"),
      inputConfig: normalizeInputConfig(null),
      actions: normalizeActions(null),
      createdByUserId: OWNER,
    });
    const cursorAfter = { id: itemId, created_at: "2026-07-01T00:00:00.000Z" };
    const run = await repo().createRun({
      spaceId: SPACE,
      ruleId: rule.id,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      triggeredByUserId: OWNER,
      triggerType: "manual",
      inputItemIds: [itemId],
      inputEvidenceIds: [],
      cursorBefore: null,
      cursorAfter,
    });
    const finished = await repo().markRunFinished({
      runId: run.id,
      spaceId: SPACE,
      status: "succeeded",
      outputArtifactIds: ["artifact-1"],
      summary: "Digest complete",
    });
    expect(finished).toMatchObject({
      status: "succeeded",
      input_item_ids: [itemId],
      output_artifact_ids: ["artifact-1"],
      summary: "Digest complete",
    });

    await repo().advanceRuleCursor({ spaceId: SPACE, ruleId: rule.id, cursor: cursorAfter });
    const reloaded = await repo().getRule(SPACE, rule.id);
    expect(reloaded?.cursor_json).toMatchObject({ source_watermark: cursorAfter });
  });

  it("persists item decisions without mutating per-user library state", async () => {
    if (!db.available) return;
    const selected = await seedItem("Relevant paper", "2026-07-01T00:00:00.000Z");
    const ignored = await seedItem("Skipped paper", "2026-07-02T00:00:00.000Z");
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      name: "Screening",
      triggerType: "manual",
      triggerConfig: normalizeTriggerConfig(null, "manual"),
      inputConfig: normalizeInputConfig(null),
      actions: normalizeActions({ batch_digest: true, mark_items: true }),
      createdByUserId: OWNER,
    });
    const run = await repo().createRun({
      spaceId: SPACE,
      ruleId: rule.id,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      triggeredByUserId: OWNER,
      triggerType: "manual",
      inputItemIds: [selected, ignored],
      inputEvidenceIds: [],
      cursorBefore: null,
      cursorAfter: { id: ignored, created_at: "2026-07-02T00:00:00.000Z" },
    });

    await repo().persistItemDecisions({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      ruleId: rule.id,
      runId: run.id,
      projectId: null,
      decisions: [{
        source_item_id: selected,
        relevance: "relevant",
        confidence: 0.9,
        reason: "Strong match.",
        matched_context_refs: [],
      }, {
        source_item_id: ignored,
        relevance: "not_relevant",
        confidence: 0.8,
        reason: "No clear match.",
        matched_context_refs: [],
      }],
    });

    const states = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM source_item_user_states
        WHERE space_id = $1
          AND source_item_id = ANY($2::varchar[])`,
      [SPACE, [selected, ignored]],
    );
    expect(states.rows[0]?.count).toBe("0");

    const decisions = await db.pool.query<{ source_item_id: string; review_status: string }>(
      `SELECT source_item_id, review_status
         FROM source_post_processing_item_decisions
        WHERE space_id = $1
        ORDER BY source_item_id`,
      [SPACE],
    );
    const [first, second] = [selected, ignored].sort();
    expect(decisions.rows).toEqual([
      { source_item_id: first, review_status: "pending" },
      { source_item_id: second, review_status: "pending" },
    ]);
  });

  it("reports backlog counts from the rule cursor", async () => {
    if (!db.available) return;
    const first = await seedItem("Paper A", "2026-07-01T00:00:00.000Z");
    const second = await seedItem("Paper B", "2026-07-02T00:00:00.000Z");
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      name: "Backlog digest",
      triggerType: "items_materialized",
      triggerConfig: normalizeTriggerConfig(null, "items_materialized"),
      inputConfig: normalizeInputConfig({ item_limit: 1, max_batches_per_event: 3 }),
      actions: normalizeActions(null),
      createdByUserId: OWNER,
    });

    const before = await repo().backlog(SPACE, CONNECTION);
    expect(before.rules.find((row) => row.rule_id === rule.id)).toMatchObject({
      pending_item_count: 2,
      batch_size: 1,
      max_batches_per_event: 3,
    });

    await repo().advanceRuleCursor({
      spaceId: SPACE,
      ruleId: rule.id,
      cursor: { id: first, created_at: "2026-07-01T00:00:00.000Z" },
    });
    const after = await repo().backlog(SPACE, CONNECTION);
    expect(after.rules.find((row) => row.rule_id === rule.id)?.pending_item_count).toBe(1);
    await repo().advanceRuleCursor({
      spaceId: SPACE,
      ruleId: rule.id,
      cursor: { id: second, created_at: "2026-07-02T00:00:00.000Z" },
    });
    const drained = await repo().backlog(SPACE, CONNECTION);
    expect(drained.rules.find((row) => row.rule_id === rule.id)?.pending_item_count).toBe(0);
  });

  it("persists item decisions as a review read model", async () => {
    if (!db.available) return;
    const itemId = await seedItem("Relevant paper", "2026-07-01T00:00:00.000Z");
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: PROJECT,
      name: "Screening",
      triggerType: "manual",
      triggerConfig: normalizeTriggerConfig(null, "manual"),
      inputConfig: normalizeInputConfig({
        relevance_profile: { enabled: true, objective: "Find relevant papers" },
      }),
      actions: normalizeActions({ batch_digest: true, mark_items: true }),
      createdByUserId: OWNER,
    });
    const run = await repo().createRun({
      spaceId: SPACE,
      ruleId: rule.id,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: PROJECT,
      triggeredByUserId: OWNER,
      triggerType: "manual",
      inputItemIds: [itemId],
      inputEvidenceIds: [],
      cursorBefore: null,
      cursorAfter: { id: itemId, created_at: "2026-07-01T00:00:00.000Z" },
    });
    await repo().persistItemDecisions({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      ruleId: rule.id,
      runId: run.id,
      projectId: PROJECT,
      decisions: [{
        source_item_id: itemId,
        relevance: "relevant",
        confidence: 0.91,
        reason: "Matches project context.",
        matched_context_refs: [{ ref: "project:project_public_summary:project-1" }],
      }],
    });

    const listed = await repo().listDecisions({
      spaceId: SPACE,
      connectionId: CONNECTION,
      reviewStatus: "pending",
      limit: 10,
      offset: 0,
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      source_channel_id: CONNECTION,
      project_id: PROJECT,
      source_item_id: itemId,
      relevance: "relevant",
      review_status: "pending",
      item: { title: "Relevant paper" },
    });

    const updated = await repo().updateDecisionReview({
      spaceId: SPACE,
      decisionId: listed.items[0]!.id,
      reviewStatus: "queued",
      action: { queue_content: { job_ids: ["job-1"] } },
    });
    expect(updated.review_status).toBe("queued");
    expect(updated.action_json).toMatchObject({ queue_content: { job_ids: ["job-1"] } });
  });

  it("aggregates the briefing stream by the rule's local day, not UTC", async () => {
    if (!db.available) return;
    const itemA = await seedItem("Relevant paper", "2026-07-01T00:00:00.000Z");
    const itemB = await seedItem("Maybe paper", "2026-07-01T00:00:00.000Z");
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      name: "Briefing digest",
      triggerType: "manual",
      triggerConfig: normalizeTriggerConfig(null, "manual"),
      // UTC+8: a run stamped 23:30 UTC falls on the *next* calendar day locally.
      inputConfig: normalizeInputConfig({ timezone: "Asia/Shanghai" }),
      actions: normalizeActions({ batch_digest: true, per_item_summary: true }),
      createdByUserId: OWNER,
    });
    const run = await repo().createRun({
      spaceId: SPACE,
      ruleId: rule.id,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      triggeredByUserId: OWNER,
      triggerType: "manual",
      inputItemIds: [itemA, itemB],
      inputEvidenceIds: [],
      cursorBefore: null,
      cursorAfter: { id: itemB, created_at: "2026-07-01T00:00:00.000Z" },
    });
    const digestArtifactId = await repo().insertArtifact({
      spaceId: SPACE,
      runId: null,
      ownerUserId: OWNER,
      projectId: null,
      artifactType: "summary",
      title: "Briefing digest",
      content: "# Digest\n\n**Relevant paper** is a strong match.\n",
      metadata: { action: "batch_digest" },
    });
    const summaryArtifactId = await repo().insertArtifact({
      spaceId: SPACE,
      runId: null,
      ownerUserId: OWNER,
      projectId: null,
      artifactType: "summary",
      title: "Summary: Relevant paper",
      content: "Concise per-item summary.",
      metadata: { action: "per_item_summary", source_item_id: itemA },
    });
    await repo().markRunFinished({
      runId: run.id,
      spaceId: SPACE,
      status: "succeeded",
      outputArtifactIds: [digestArtifactId, summaryArtifactId],
      summary: "Digest complete",
    });
    await repo().persistItemDecisions({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      ruleId: rule.id,
      runId: run.id,
      projectId: null,
      decisions: [
        { source_item_id: itemA, relevance: "relevant", confidence: 0.9, reason: "Strong match.", matched_context_refs: [] },
        { source_item_id: itemB, relevance: "maybe", confidence: 0.5, reason: "Unclear.", matched_context_refs: [] },
      ],
    });
    // createRun/markRunFinished always stamp `now()`; back-date the run directly
    // to a timestamp whose UTC and Asia/Shanghai calendar dates differ, so the
    // assertions below only pass if the bucketing is actually timezone-aware.
    await db.pool.query(
      `UPDATE source_post_processing_runs SET created_at = '2026-07-07T23:30:00.000Z' WHERE id = $1`,
      [run.id],
    );

    const list = await repo().listBriefings({ spaceId: SPACE, userId: OWNER, limit: 10, offset: 0 });
    expect(list.total).toBe(1);
    const summary = list.items[0]!;
    expect(summary).toMatchObject({
      source_channel_id: CONNECTION,
      connection_name: "arXiv",
      date: "2026-07-08",
      run_ids: [run.id],
      run_count: 1,
      item_decision_counts: { relevant: 1, maybe: 1, not_relevant: 0 },
      digest_artifact_id: digestArtifactId,
    });
    expect(summary.digest_preview).toBe("Digest Relevant paper is a strong match.");

    const detail = await repo().getBriefing({ spaceId: SPACE, userId: OWNER, connectionId: CONNECTION, date: "2026-07-08" });
    expect(detail).toMatchObject({
      source_channel_id: CONNECTION,
      connection_name: "arXiv",
      date: "2026-07-08",
      runs: [{ run_id: run.id, status: "succeeded" }],
      digests: [{ run_id: run.id, artifact_id: digestArtifactId }],
      item_summaries: [{ source_item_id: itemA, artifact_id: summaryArtifactId }],
    });
    expect(detail!.item_decisions.map((d) => d.source_item_id).sort()).toEqual([itemA, itemB].sort());

    expect(await repo().getBriefing({ spaceId: SPACE, userId: OWNER, connectionId: CONNECTION, date: "2099-01-01" })).toBeNull();
  });

  it("emits and re-surfaces one daily Activity Inbox briefing pointer per source local day", async () => {
    if (!db.available) return;
    const itemA = await seedItem("Relevant paper", "2026-07-01T00:00:00.000Z");
    const itemB = await seedItem("Maybe paper", "2026-07-01T00:00:00.000Z");
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: PROJECT,
      name: "Daily briefing",
      triggerType: "manual",
      triggerConfig: normalizeTriggerConfig(null, "manual"),
      inputConfig: normalizeInputConfig({ timezone: "Asia/Shanghai" }),
      actions: normalizeActions({ batch_digest: true, mark_items: true }),
      createdByUserId: OWNER,
    });
    const run = await repo().createRun({
      spaceId: SPACE,
      ruleId: rule.id,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: PROJECT,
      triggeredByUserId: OWNER,
      triggerType: "manual",
      inputItemIds: [itemA, itemB],
      inputEvidenceIds: [],
      cursorBefore: null,
      cursorAfter: null,
    });
    await db.pool.query(
      `UPDATE source_post_processing_runs SET created_at = '2026-07-07T23:30:00.000Z' WHERE id = $1`,
      [run.id],
    );
    const digestArtifactId = await repo().insertArtifact({
      spaceId: SPACE,
      runId: null,
      ownerUserId: OWNER,
      projectId: PROJECT,
      artifactType: "summary",
      title: "Daily digest",
      content: "# First digest\n\nFull body stays in Brief, not Activity.\n",
      metadata: { action: "batch_digest" },
    });
    await repo().persistItemDecisions({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      ruleId: rule.id,
      runId: run.id,
      projectId: PROJECT,
      decisions: [
        { source_item_id: itemA, relevance: "relevant", confidence: 0.9, reason: "Strong match.", matched_context_refs: [] },
        { source_item_id: itemB, relevance: "maybe", confidence: 0.5, reason: "Unclear.", matched_context_refs: [] },
      ],
    });
    await repo().markRunFinished({
      runId: run.id,
      spaceId: SPACE,
      status: "succeeded",
      outputArtifactIds: [digestArtifactId],
      summary: "Digest complete",
    });

    const aggregateKey = `source:briefing:${CONNECTION}:2026-07-08`;
    const first = await db.pool.query<{
      id: string;
      title: string;
      content: string;
      payload_json: {
        briefing_date: string;
        source_channel_id: string;
        post_processing_run_ids: string[];
        artifact_ids: string[];
        decision_counts: { relevant: number; maybe: number; not_relevant: number };
      };
      status: string;
      processed_at: Date | null;
      project_id: string | null;
      aggregate_key: string;
    }>(
      `SELECT id, title, content, payload_json, status, processed_at, project_id, aggregate_key
         FROM activity_records
        WHERE space_id = $1 AND aggregate_key = $2`,
      [SPACE, aggregateKey],
    );
    expect(first.rowCount).toBe(1);
    const firstRow = first.rows[0]!;
    expect(firstRow).toMatchObject({
      aggregate_key: aggregateKey,
      project_id: PROJECT,
      status: "raw",
    });
    expect(firstRow.title).toContain("arXiv - 2026-07-08 briefing");
    expect(firstRow.content).toContain("2 items screened: 1 relevant, 1 maybe, 0 not relevant.");
    expect(firstRow.content).toContain("First digest");
    expect(firstRow.payload_json).toMatchObject({
      briefing_date: "2026-07-08",
      source_channel_id: CONNECTION,
      post_processing_run_ids: [run.id],
      artifact_ids: [digestArtifactId],
      decision_counts: { relevant: 1, maybe: 1, not_relevant: 0 },
    });

    await db.pool.query(
      `UPDATE activity_records
          SET status = 'processed', processed_at = '2026-07-08T12:00:00.000Z'
        WHERE id = $1`,
      [firstRow.id],
    );
    const itemC = await seedItem("Skipped paper", "2026-07-02T00:00:00.000Z");
    const secondRun = await repo().createRun({
      spaceId: SPACE,
      ruleId: rule.id,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: PROJECT,
      triggeredByUserId: OWNER,
      triggerType: "manual",
      inputItemIds: [itemC],
      inputEvidenceIds: [],
      cursorBefore: null,
      cursorAfter: null,
    });
    await db.pool.query(
      `UPDATE source_post_processing_runs SET created_at = '2026-07-08T10:00:00.000Z' WHERE id = $1`,
      [secondRun.id],
    );
    await repo().persistItemDecisions({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      ruleId: rule.id,
      runId: secondRun.id,
      projectId: PROJECT,
      decisions: [
        { source_item_id: itemC, relevance: "not_relevant", confidence: 0.8, reason: "Not useful.", matched_context_refs: [] },
      ],
    });
    await repo().markRunFinished({
      runId: secondRun.id,
      spaceId: SPACE,
      status: "succeeded",
      outputArtifactIds: [],
      summary: "Second digest complete",
    });

    const resurfaced = await db.pool.query<typeof first.rows[number]>(
      `SELECT id, title, content, payload_json, status, processed_at, project_id, aggregate_key
         FROM activity_records
        WHERE space_id = $1 AND aggregate_key = $2`,
      [SPACE, aggregateKey],
    );
    const resurfacedRow = resurfaced.rows[0]!;
    expect(resurfaced.rowCount).toBe(1);
    expect(resurfacedRow.id).toBe(firstRow.id);
    expect(resurfacedRow.status).toBe("raw");
    expect(resurfacedRow.processed_at).toBeNull();
    expect(resurfacedRow.payload_json.post_processing_run_ids).toEqual([secondRun.id, run.id]);
    expect(resurfacedRow.payload_json.decision_counts).toEqual({ relevant: 1, maybe: 1, not_relevant: 1 });

    await db.pool.query(
      `UPDATE activity_records
          SET status = 'processed', processed_at = '2026-07-08T13:00:00.000Z'
        WHERE id = $1`,
      [firstRow.id],
    );
    await repo().upsertDailyBriefingActivity({ spaceId: SPACE, runId: secondRun.id });
    const replay = await db.pool.query<{ status: string; processed_at: Date | null }>(
      `SELECT status, processed_at
         FROM activity_records
        WHERE space_id = $1 AND aggregate_key = $2`,
      [SPACE, aggregateKey],
    );
    expect(replay.rows[0]).toMatchObject({ status: "processed" });
    expect(replay.rows[0]!.processed_at).not.toBeNull();
  });

  it("honors the per-source daily Inbox briefing toggle at emission time", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE source_connections SET config_json = '{"daily_inbox_briefing": false}'::jsonb WHERE id = $1`,
      [CONNECTION],
    );
    const itemId = await seedItem("Muted paper", "2026-07-01T00:00:00.000Z");
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      name: "Muted briefing",
      triggerType: "manual",
      triggerConfig: normalizeTriggerConfig(null, "manual"),
      inputConfig: normalizeInputConfig({ timezone: "UTC" }),
      actions: normalizeActions({ batch_digest: true, mark_items: true }),
      createdByUserId: OWNER,
    });
    const run = await repo().createRun({
      spaceId: SPACE,
      ruleId: rule.id,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      triggeredByUserId: OWNER,
      triggerType: "manual",
      inputItemIds: [itemId],
      inputEvidenceIds: [],
      cursorBefore: null,
      cursorAfter: null,
    });
    await db.pool.query(
      `UPDATE source_post_processing_runs SET created_at = '2026-07-08T10:00:00.000Z' WHERE id = $1`,
      [run.id],
    );
    await repo().persistItemDecisions({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      ruleId: rule.id,
      runId: run.id,
      projectId: null,
      decisions: [
        { source_item_id: itemId, relevance: "relevant", confidence: 0.9, reason: "Relevant.", matched_context_refs: [] },
      ],
    });
    await repo().markRunFinished({
      runId: run.id,
      spaceId: SPACE,
      status: "succeeded",
      outputArtifactIds: [],
      summary: "Muted digest",
    });

    const rows = await db.pool.query(
      `SELECT id FROM activity_records WHERE space_id = $1 AND aggregate_key = $2`,
      [SPACE, `source:briefing:${CONNECTION}:2026-07-08`],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("indexes scheduled active rules through scheduler tasks", async () => {
    if (!db.available) return;
    const rule = await repo().createRule({
      spaceId: SPACE,
      sourceChannelId: CONNECTION,
      agentId: AGENT,
      projectId: null,
      name: "Scheduled digest",
      triggerType: "schedule",
      triggerConfig: normalizeTriggerConfig({ cron: "0 9 * * *", timezone: "UTC" }, "schedule"),
      inputConfig: normalizeInputConfig(null),
      actions: normalizeActions(null),
      createdByUserId: OWNER,
    });
    await db.pool.query(
      `UPDATE scheduler_tasks
          SET next_run_at = '2026-07-01T09:00:00.000Z'
        WHERE task_type = $1 AND task_key = $2`,
      [SOURCE_POST_PROCESSING_TASK_TYPE, rule.id],
    );

    const due = await repo().listDueRules("2026-07-01T09:00:01.000Z", 10);
    expect(due.map((row) => row.id)).toEqual([rule.id]);

    await repo().updateRule(SPACE, rule.id, { status: "paused" });
    const pausedDue = await repo().listDueRules("2026-07-01T09:00:02.000Z", 10);
    expect(pausedDue).toHaveLength(0);
  });
});
