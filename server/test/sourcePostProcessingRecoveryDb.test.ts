import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedArxivSourceChain } from "./support/researchSeeds";
import { useTestDatabase } from "./support/testDatabase";
import { seedAgentWithVersion } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { SourcePostProcessingRecoveryService } from "../src/modules/sources/postProcessing/recoveryService";
import { reconcileProjectResearch } from "../src/modules/scheduler/backgroundServices";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for ensureItemsProcessed dispatching only the items
// that still lack a decision. Before this fix, any recovery pass with even
// one unclassified item (e.g. a Rescan that adds a single new paper) resent
// EVERY item in scope — including already-classified ones — to the
// processing rule; evidence extraction has no per-item idempotency guard, so
// re-sending an already-screened paper mints a second, duplicate
// extracted_evidence row for it.

const CONFIG = loadConfig({});
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "88888888-8888-4888-8888-888888888888";
const AGENT = "99999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";
const RULE = "cccccccc-1111-4111-8111-111111111111";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const WORKFLOW = "88888888-1111-4111-8111-111111111111";
const ITEM_1 = "item-already-classified-1";
const ITEM_2 = "item-already-classified-2";
const ITEM_3 = "item-newly-added-unclassified";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["jobs", "project_operation_steps", "project_operations", "project_research_workflows", "source_post_processing_item_decisions", "source_post_processing_runs", "source_post_processing_rules", "source_channel_item_links", "source_items", "agents", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, current_focus, created_at, updated_at) VALUES ($1,$2,$3,'Research','active','Research',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await seedArxivSourceChain(db.pool, { connector: CONNECTOR, connection: CONNECTION, channel: CHANNEL, space: SPACE, owner: OWNER, now });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, name: "Screening Agent", now });
  await db.pool.query(
    `INSERT INTO source_post_processing_rules (
       id, space_id, source_channel_id, agent_id, project_id, name, status, trigger_type,
       trigger_config_json, input_config_json, actions_json, created_by_user_id, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'Screening rule','active','items_materialized','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$6,$7,$7)`,
    [RULE, SPACE, CHANNEL, AGENT, PROJECT, OWNER, now],
  );
  for (const itemId of [ITEM_1, ITEM_2, ITEM_3]) {
    await db.pool.query(
      `INSERT INTO source_items (
         id, space_id, owner_user_id, visibility, connection_id, item_type, title, first_seen_at, last_seen_at,
         content_state, retention_policy, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared',$4,'external_url',$1,$5,$5,'excerpt_saved','summary_only',$5,$5)`,
      [itemId, SPACE, OWNER, CONNECTION, now],
    );
    await db.pool.query(
      `INSERT INTO source_channel_item_links (id, space_id, source_channel_id, source_item_id, status, matched_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, itemId, now],
    );
  }
  for (const itemId of [ITEM_1, ITEM_2]) {
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_post_processing_runs (id, space_id, source_channel_id, agent_id, project_id, rule_id, trigger_type, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'manual','succeeded',$7)`,
      [runId, SPACE, CHANNEL, AGENT, PROJECT, RULE, now],
    );
    await db.pool.query(
      `INSERT INTO source_post_processing_item_decisions (
         id, space_id, source_channel_id, run_id, project_id, source_item_id, relevance, review_status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'relevant','accepted',$7,$7)`,
      [randomUUID(), SPACE, CHANNEL, runId, PROJECT, itemId, now],
    );
  }
});

describe("SourcePostProcessingRecoveryService.ensureItemsProcessed (real Postgres)", () => {
  it("only dispatches the unclassified item, not the ones already classified in a prior pass", async () => {
    if (!db.available) return;

    const result = await new SourcePostProcessingRecoveryService(db.pool).ensureItemsProcessed({
      spaceId: SPACE,
      projectId: PROJECT,
      channelIds: [CHANNEL],
      ruleIds: [RULE],
      sourceItemIds: [ITEM_1, ITEM_2, ITEM_3],
      operationId: OPERATION,
      researchQuestionVersion: 1,
    });

    expect(result.status).toBe("waiting");
    const jobs = await db.pool.query<{ priority: number; max_attempts: number; payload_json: { source_item_ids?: string[] } }>(
      `SELECT priority, max_attempts, payload_json FROM jobs
        WHERE space_id=$1 AND job_type='source_post_processing_event'
          AND payload_json->>'recovery_for_operation_id'=$2`,
      [SPACE, OPERATION],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ priority: 50, max_attempts: 2 });
    expect(jobs.rows[0]!.payload_json.source_item_ids).toEqual([ITEM_3]);
  });

  it("reports ready without dispatching anything when every item is already classified", async () => {
    if (!db.available) return;
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_post_processing_runs (id, space_id, source_channel_id, agent_id, project_id, rule_id, trigger_type, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'manual','succeeded',$7)`,
      [runId, SPACE, CHANNEL, AGENT, PROJECT, RULE, new Date().toISOString()],
    );
    await db.pool.query(
      `INSERT INTO source_post_processing_item_decisions (
         id, space_id, source_channel_id, run_id, project_id, source_item_id, relevance, review_status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'maybe','accepted',$7,$7)`,
      [randomUUID(), SPACE, CHANNEL, runId, PROJECT, ITEM_3, new Date().toISOString()],
    );

    const result = await new SourcePostProcessingRecoveryService(db.pool).ensureItemsProcessed({
      spaceId: SPACE,
      projectId: PROJECT,
      channelIds: [CHANNEL],
      ruleIds: [RULE],
      sourceItemIds: [ITEM_1, ITEM_2, ITEM_3],
      operationId: OPERATION,
      researchQuestionVersion: 1,
    });

    expect(result.status).toBe("ready");
    const jobs = await db.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE space_id=$1 AND job_type='source_post_processing_event'`,
      [SPACE],
    );
    expect(jobs.rows).toHaveLength(0);
  });

  it("reconciles a succeeded project run from the durable scheduler scan when its hook was lost", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };
    const thread = await new InquiryThreadService(db.pool).createThread(
      identity,
      PROJECT,
      { kind: "question", statement: "Research" },
    );
    await insertResearchWorkflowFixture(db.pool, {
      id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
      currentStage: "monitoring", primaryThreadId: String(thread.id), state: {
          channel_ids: [CHANNEL],
          source_post_processing_rule_ids: [RULE],
          monitoring: { active: true, field: "submittedDate" },
          research_question: "Research",
          research_question_version: thread.version,
          thread_scope: [{ thread_id: thread.id, version: thread.version, kind: "question", statement: thread.statement }],
          report_depth: "full",
          question_refine_skipped: false,
          agent_id: AGENT,
          runtime_profile_id: "profile-1",
        }, now,
    });
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_post_processing_runs (
         id, space_id, source_channel_id, agent_id, project_id, rule_id, trigger_type,
         status, input_item_ids_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'manual','succeeded',$7::jsonb,$8)`,
      [runId, SPACE, CHANNEL, AGENT, PROJECT, RULE, JSON.stringify([ITEM_3]), now],
    );

    await reconcileProjectResearch(db.pool, CONFIG);

    const run = await db.pool.query<{ research_reconciled_at: string | null }>(
      `SELECT research_reconciled_at FROM source_post_processing_runs WHERE id=$1`,
      [runId],
    );
    expect(run.rows[0]!.research_reconciled_at).not.toBeNull();
    const operations = await db.pool.query<{ progress_json: { run_kind?: string; source_item_ids?: string[] } }>(
      `SELECT progress_json FROM project_operations WHERE project_id=$1 AND kind='research'`,
      [PROJECT],
    );
    expect(operations.rows).toHaveLength(1);
    expect(operations.rows[0]!.progress_json).toMatchObject({
      run_kind: "incremental",
      source_item_ids: [ITEM_3],
    });
  });

  it("marks recovery reconciled without mutating an archived Project", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_post_processing_runs (
         id,space_id,source_channel_id,agent_id,project_id,rule_id,trigger_type,status,input_item_ids_json,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'manual','succeeded',$7::jsonb,$8)`,
      [runId, SPACE, CHANNEL, AGENT, PROJECT, RULE, JSON.stringify([ITEM_3]), now],
    );
    await db.pool.query(`UPDATE projects SET status='archived',archived_at=$3 WHERE id=$1 AND space_id=$2`, [PROJECT, SPACE, now]);

    await reconcileProjectResearch(db.pool, CONFIG);

    expect((await db.pool.query<{ research_reconciled_at: string | null }>(
      `SELECT research_reconciled_at FROM source_post_processing_runs WHERE id=$1`, [runId],
    )).rows[0]?.research_reconciled_at).not.toBeNull();
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_operations WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    )).rows[0]?.count).toBe("0");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_corpus_items WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    )).rows[0]?.count).toBe("0");
  });
});
