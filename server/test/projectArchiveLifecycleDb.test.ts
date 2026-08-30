import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { loadConfig } from "../src/config.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { ProjectOperationService } from "../src/modules/projects/projectOperationService.js";
import { advanceOperation } from "../src/modules/projectResearch/operationProjection.js";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator.js";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

const CONFIG = loadConfig({});
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT = "55555555-5555-4555-8555-666666666666";
const AGENT = "66666666-6666-4666-8666-666666666666";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "77777777-7777-4777-8777-777777777777";


const db = useTestDatabase(import.meta.filename);

beforeAll(async () => {
  if (!db.available) return;
  registerProjectResearchExecutionHandlers();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_operations", "project_research_workflows", "source_post_processing_rules", "project_source_bindings", "automations", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
     VALUES ($1,$2,$3,'Archived target','active',$5,$5),
            ($4,$2,$3,'Unaffected project','active',$5,$5)`,
    [PROJECT, SPACE, OWNER, OTHER_PROJECT, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  await db.pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,visibility,created_at,updated_at)
     VALUES ($1,$2,$3,'Research Agent','active','space_shared',$4,$4)`,
    [AGENT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_connectors (
       id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at
     ) VALUES ($1,'archive-test','Archive Test','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at)
     VALUES ($1,'archive-test','Archive Test','named','academic','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const mappingId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at)
     VALUES ($1,$2,$2,'active',0,'{}'::jsonb,$3,$3)`,
    [mappingId, CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_connections (
       id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,
       consent_json,policy_json,config_json,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'Archive Source','active','reference_only','normal',
               $5::jsonb,'{}'::jsonb,'{}'::jsonb,$6,$6)`,
    [CONNECTION, SPACE, mappingId, OWNER, JSON.stringify({ schema_version: 1, owner_user_id: OWNER }), now],
  );
  await db.pool.query(
    `INSERT INTO source_channels (
       id,space_id,source_connection_id,created_by_user_id,name,channel_type,endpoint_url,
       query_json,provider_query_json,query_fingerprint,status,fetch_frequency,schedule_rule_json,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'Archive Channel','search','https://example.test/feed',
               '{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,$5,$5)`,
    [CHANNEL, SPACE, CONNECTION, OWNER, now],
  );

  for (const projectId of [PROJECT, OTHER_PROJECT]) {
    await db.pool.query(
      `INSERT INTO automations (id,space_id,owner_user_id,agent_id,project_id,name,trigger_type,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'Project Automation','schedule','active',$6,$6)`,
      [randomUUID(), SPACE, OWNER, AGENT, projectId, now],
    );
    await db.pool.query(
      `INSERT INTO project_source_bindings (
         id,space_id,project_id,source_channel_id,binding_key,status,priority,delivery_scope,
         collection_notifications_enabled,filters_json,routing_policy_json,extraction_policy_json,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,'active',0,'project_members',true,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$6,$6)`,
      [randomUUID(), SPACE, projectId, CHANNEL, projectId, now],
    );
    await db.pool.query(
      `INSERT INTO source_post_processing_rules (
         id,space_id,source_channel_id,agent_id,project_id,name,status,trigger_type,
         trigger_config_json,input_config_json,actions_json,created_by_user_id,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'active','items_materialized','{}'::jsonb,'{}'::jsonb,
                 '{"batch_digest":true}'::jsonb,$7,$8,$8)`,
      [randomUUID(), SPACE, CHANNEL, AGENT, projectId, projectId, OWNER, now],
    );
    const workflowId = randomUUID();
    await insertResearchWorkflowFixture(db.pool, {
      id: workflowId, spaceId: SPACE, projectId, startedByUserId: OWNER,
      currentStage: "screening", now,
    });
    await db.pool.query(
      `INSERT INTO project_operations (
         id,space_id,project_id,kind,title,status,progress_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'research','Research Operation','active',$4::jsonb,$5,$5)`,
      [randomUUID(), SPACE, projectId, JSON.stringify({ workflow_id: workflowId, current_stage: "screening" }), now],
    );
  }
});

describe("Project archive lifecycle (real Postgres)", () => {
  it("atomically pauses future work, cancels active research orchestration, and does not auto-resume", async () => {
    if (!db.available) return;
    const repository = new PgProjectRepository(db.pool);
    const identity = { spaceId: SPACE, userId: OWNER };

    const archived = await repository.archive(identity, PROJECT);
    expect(archived.status).toBe("archived");

    const statuses = await db.pool.query<{
      automation_status: string;
      binding_status: string;
      rule_status: string;
      workflow_status: string;
      operation_status: string;
      operation_version: number;
    }>(
      `SELECT automation.status AS automation_status,
              binding.status AS binding_status,
              rule.status AS rule_status,
              workflow.status AS workflow_status,
              operation.status AS operation_status,
              operation.version AS operation_version
         FROM automations automation
         JOIN project_source_bindings binding ON binding.project_id=automation.project_id AND binding.space_id=automation.space_id
         JOIN source_post_processing_rules rule ON rule.project_id=automation.project_id AND rule.space_id=automation.space_id
         JOIN project_research_workflows workflow ON workflow.project_id=automation.project_id AND workflow.space_id=automation.space_id
         JOIN project_operations operation ON operation.project_id=automation.project_id AND operation.space_id=automation.space_id
        WHERE automation.space_id=$1 AND automation.project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(statuses.rows[0]).toEqual({
      automation_status: "paused",
      binding_status: "paused",
      rule_status: "paused",
      workflow_status: "paused",
      operation_status: "cancelled",
      operation_version: 2,
    });
    await expect(new ProjectOperationService(db.pool).create(identity, PROJECT, {
      kind: "research",
      title: "Must not restart",
    })).rejects.toMatchObject({ statusCode: 409 });

    const unaffected = await db.pool.query<{ statuses: string[] }>(
      `SELECT ARRAY[
         (SELECT status FROM automations WHERE space_id=$1 AND project_id=$2),
         (SELECT status FROM project_source_bindings WHERE space_id=$1 AND project_id=$2),
         (SELECT status FROM source_post_processing_rules WHERE space_id=$1 AND project_id=$2),
         (SELECT status FROM project_research_workflows WHERE space_id=$1 AND project_id=$2),
         (SELECT status FROM project_operations WHERE space_id=$1 AND project_id=$2)
       ] AS statuses`,
      [SPACE, OTHER_PROJECT],
    );
    expect(unaffected.rows[0]!.statuses).toEqual(["active", "active", "active", "active", "active"]);

    await repository.archive(identity, PROJECT);
    const idempotent = await db.pool.query<{ version: number }>(
      `SELECT version FROM project_operations WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(idempotent.rows[0]!.version).toBe(2);

    const reactivated = await repository.update(identity, PROJECT, { status: "active" });
    expect(reactivated.status).toBe("active");
    const stillStopped = await db.pool.query<{ automation: string; workflow: string; operation: string }>(
      `SELECT
         (SELECT status FROM automations WHERE space_id=$1 AND project_id=$2) AS automation,
         (SELECT status FROM project_research_workflows WHERE space_id=$1 AND project_id=$2) AS workflow,
         (SELECT status FROM project_operations WHERE space_id=$1 AND project_id=$2) AS operation`,
      [SPACE, PROJECT],
    );
    expect(stillStopped.rows[0]).toEqual({ automation: "paused", workflow: "paused", operation: "cancelled" });
  });

  it("serializes archive with a research advanceOperation without deadlock", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: OWNER };
    const results = await Promise.allSettled([
      new PgProjectRepository(db.pool).archive(identity, PROJECT),
      advanceOperation(db.pool, SPACE, (await db.pool.query<{ id: string }>(
        `SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2`,
        [SPACE, PROJECT],
      )).rows[0]!.id, {
        from: ["screening"],
        to: "complete",
        mutate: ({ state }) => { state.stage_state = "succeeded"; },
      }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const final = await db.pool.query<{ project_status: string; workflow_status: string; operation_status: string }>(
      `SELECT p.status AS project_status, w.status AS workflow_status, o.status AS operation_status
         FROM projects p
         JOIN project_research_workflows w ON w.space_id=p.space_id AND w.project_id=p.id
         JOIN project_operations o ON o.space_id=p.space_id AND o.project_id=p.id
        WHERE p.space_id=$1 AND p.id=$2`,
      [SPACE, PROJECT],
    );
    expect(final.rows[0]!.project_status).toBe("archived");
    expect(final.rows[0]!.workflow_status).toBe("paused");
    expect(["cancelled", "completed"]).toContain(final.rows[0]!.operation_status);
  });

  it("serializes archive with research creation and leaves no active work", async () => {
    if (!db.available) return;
    await db.pool.query(`DELETE FROM project_operations WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    const workflow = await db.pool.query<{ id: string }>(
      `SELECT object_id AS id FROM project_research_workflows WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    const state = {
      schema_version: "project_research_operation.v1",
      run_kind: "incremental",
      workflow_id: workflow.rows[0]!.id,
      current_stage: "screening",
      stage_state: "running",
    };
    await Promise.allSettled([
      new PgProjectRepository(db.pool).archive({ spaceId: SPACE, userId: OWNER }, PROJECT),
      new ProjectOperationService(db.pool).createManagedResearch({ spaceId: SPACE, userId: OWNER }, PROJECT, {
        title: "Concurrent operation",
        intentText: "Must be rejected or cancelled by archive",
        status: "active",
        progress: state,
        steps: [{ title: "Screen", status: "active" }],
      }),
    ]);
    const final = await db.pool.query<{ project_status: string; active_operations: number }>(
      `SELECT p.status AS project_status,
              count(o.id) FILTER (WHERE o.status IN ('draft','active','waiting_review'))::int AS active_operations
         FROM projects p
         LEFT JOIN project_operations o ON o.space_id=p.space_id AND o.project_id=p.id
        WHERE p.space_id=$1 AND p.id=$2 GROUP BY p.status`,
      [SPACE, PROJECT],
    );
    expect(final.rows[0]).toEqual({ project_status: "archived", active_operations: 0 });
  });

  it("does not lose pending incremental items when archive wins the producer race", async () => {
    if (!db.available) return;
    const pendingItemId = "99999999-9999-4999-8999-999999999999";
    await db.pool.query(`DELETE FROM project_operations WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    const workflow = await db.pool.query<{ id: string }>(
      `SELECT object_id AS id FROM project_research_workflows WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    const binding = await db.pool.query<{ id: string }>(
      `SELECT id FROM project_source_bindings WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    const question = "Does archive preserve queued incremental work?";
    const thread = await new InquiryThreadService(db.pool).createThread(
      { spaceId: SPACE, userId: OWNER },
      PROJECT,
      { kind: "question", statement: question },
    );
    await db.pool.query(`UPDATE projects SET current_focus=$3 WHERE space_id=$1 AND id=$2`, [SPACE, PROJECT, question]);
    await db.pool.query(
      `UPDATE project_research_workflows
          SET state_json=$4::jsonb
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3`,
      [SPACE, PROJECT, workflow.rows[0]!.id, JSON.stringify({
        research_question: question,
        research_question_version: 1,
        thread_scope: [{ thread_id: thread.id, version: thread.version, kind: "question", statement: thread.statement }],
        monitoring: { active: true },
        monitoring_active: true,
        report_depth: "quick",
        channel_ids: [CHANNEL],
        project_source_binding_ids: [binding.rows[0]!.id],
        pending_incremental_source_item_ids: [pendingItemId],
      })],
    );
    await Promise.allSettled([
      new PgProjectRepository(db.pool).archive({ spaceId: SPACE, userId: OWNER }, PROJECT),
      new ProjectResearchOrchestrator(db.pool, CONFIG).triggerIncremental(
        { spaceId: SPACE, userId: OWNER }, PROJECT, workflow.rows[0]!.id,
        { idempotency_key: "archive-pending-race" },
      ),
    ]);
    const final = await db.pool.query<{ project_status: string; active_operations: number; operation_count: number; pending_ids: unknown }>(
      `SELECT p.status AS project_status,
              count(o.id) FILTER (WHERE o.status IN ('draft','active','waiting_review'))::int AS active_operations,
              count(o.id)::int AS operation_count,
              w.state_json->'pending_incremental_source_item_ids' AS pending_ids
         FROM projects p
         JOIN project_research_workflows w ON w.space_id=p.space_id AND w.project_id=p.id
         LEFT JOIN project_operations o ON o.space_id=p.space_id AND o.project_id=p.id
        WHERE p.space_id=$1 AND p.id=$2
        GROUP BY p.status,w.state_json`,
      [SPACE, PROJECT],
    );
    expect(final.rows[0]!.project_status).toBe("archived");
    expect(final.rows[0]!.active_operations).toBe(0);
    if (final.rows[0]!.operation_count === 0) {
      expect(final.rows[0]!.pending_ids).toEqual([pendingItemId]);
    }
  });

  it("serializes pending incremental append with consumption without losing either item", async () => {
    if (!db.available) return;
    const firstItem = "88888888-8888-4888-8888-888888888881";
    const appendedItem = "88888888-8888-4888-8888-888888888882";
    await db.pool.query(`DELETE FROM project_operations WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    const workflow = await db.pool.query<{ id: string }>(
      `SELECT object_id AS id FROM project_research_workflows WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    const binding = await db.pool.query<{ id: string }>(
      `SELECT id FROM project_source_bindings WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    const question = "Can pending incremental work be consumed without loss?";
    const thread = await new InquiryThreadService(db.pool).createThread(
      { spaceId: SPACE, userId: OWNER },
      PROJECT,
      { kind: "question", statement: question },
    );
    await db.pool.query(`UPDATE projects SET current_focus=$3 WHERE space_id=$1 AND id=$2`, [SPACE, PROJECT, question]);
    await db.pool.query(
      `UPDATE project_research_workflows SET state_json=$4::jsonb
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3`,
      [SPACE, PROJECT, workflow.rows[0]!.id, JSON.stringify({
        research_question: question,
        research_question_version: 1,
        thread_scope: [{ thread_id: thread.id, version: thread.version, kind: "question", statement: thread.statement }],
        monitoring: { active: true },
        monitoring_active: true,
        report_depth: "quick",
        channel_ids: [CHANNEL],
        project_source_binding_ids: [binding.rows[0]!.id],
        pending_incremental_source_item_ids: [firstItem],
      })],
    );
    const orchestrator = new ProjectResearchOrchestrator(db.pool, CONFIG);
    const pendingAppender = orchestrator as unknown as {
      appendPendingIncrementalItems(spaceId: string, projectId: string, workflowId: string, itemIds: string[]): Promise<void>;
    };
    await Promise.all([
      pendingAppender.appendPendingIncrementalItems(SPACE, PROJECT, workflow.rows[0]!.id, [appendedItem]),
      orchestrator.triggerIncremental(
        { spaceId: SPACE, userId: OWNER }, PROJECT, workflow.rows[0]!.id,
        { idempotency_key: "pending-append-consume-race" },
      ),
    ]);
    const durable = await db.pool.query<{ operation_ids: unknown; pending_ids: unknown }>(
      `SELECT operation.progress_json->'source_item_ids' AS operation_ids,
              workflow.state_json->'pending_incremental_source_item_ids' AS pending_ids
         FROM project_research_workflows workflow
         JOIN project_operations operation
           ON operation.space_id=workflow.space_id
          AND operation.project_id=workflow.project_id
          AND operation.progress_json->>'workflow_id'=workflow.object_id
        WHERE workflow.space_id=$1 AND workflow.project_id=$2 AND workflow.object_id=$3`,
      [SPACE, PROJECT, workflow.rows[0]!.id],
    );
    const durableIds = new Set([
      ...(Array.isArray(durable.rows[0]!.operation_ids) ? durable.rows[0]!.operation_ids as string[] : []),
      ...(Array.isArray(durable.rows[0]!.pending_ids) ? durable.rows[0]!.pending_ids as string[] : []),
    ]);
    expect(durableIds).toEqual(new Set([firstItem, appendedItem]));
  });
});
