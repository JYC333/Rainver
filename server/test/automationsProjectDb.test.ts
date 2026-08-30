import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { Pool } from "pg";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import type { ServerConfig } from "../src/config.js";

// Real-PostgreSQL tests for automation × project binding: automations.project_id
// persistence (create/update/clear), the composite (space_id, project_id) FK,
// the project-writer authorization on bind, the 422 for non-agent_run targets,
// and the fire path carrying project_id onto the created run row. Skips when
// Docker is unavailable.

const dbPoolMock: { current: Pool | undefined } = { current: undefined };

vi.mock("../src/db/pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/pool.js")>();
  return {
    ...actual,
    getDbPool: vi.fn((databaseUrl: string) => dbPoolMock.current ?? actual.getDbPool(databaseUrl)),
  };
});

vi.mock("../src/modules/policy/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/policy/index.js")>();
  return {
    ...actual,
    enforce: vi.fn(async () => ({ status: "allow" as const })),
  };
});

vi.mock("../src/modules/policy/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/policy/gateway.js")>();
  return {
    ...actual,
    computeDecision: vi.fn(() => ({
      decision: { decision: "allow", message: null, reason_code: null, policy_rule_id: null, audit_code: null },
    })),
  };
});

import { AutomationService } from "../src/modules/automations/service.js";
import { PgAutomationRepository } from "../src/modules/automations/repository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { assertBudgetSourcesAvailable, checkRunBudget } from "../src/modules/runs/budgetEnforcement.js";
import type { RunRecord } from "../src/modules/runs/runRepositoryTypes.js";
import { WorkflowExecutionService } from "../src/modules/automations/workflowExecutionService.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // space owner + project owner
const MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // plain space member, not a project member
const PROJECT = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT = "66666666-6666-4666-8666-666666666666"; // lives in OTHER_SPACE
const AGENT = "77777777-7777-4777-8777-777777777777";
const AGENT_VERSION = "88888888-8888-4888-8888-888888888888";
const WORKFLOW_ASSET = "99999999-9999-4999-8999-999999999999";
const WORKFLOW_VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";

const config = {
  databaseUrl: "postgresql://test@test:5432/test",
} as unknown as ServerConfig;

const sharedPostgres = inject("sharedPostgres");
const describeWithPostgres = describe.skipIf(
  !sharedPostgres.available || !sharedPostgres.adminUri || !sharedPostgres.templateDatabase || !sharedPostgres.runId,
);

const db = useTestDatabase(import.meta.filename);

beforeAll(async () => {
  if (!db.available) return;
  dbPoolMock.current = db.pool;
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["evolvable_asset_pins", "evolvable_asset_versions", "evolvable_assets", "automation_runs", "automation_credential_grants", "automations", "scheduler_tasks", "jobs", "runs", "agent_runtime_profiles", "agent_versions", "agents", "source_items", "project_source_item_links", "project_source_bindings", "source_connections", "source_connectors", "project_folders", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  for (const [spaceId, name] of [[SPACE, "Main"], [OTHER_SPACE, "Other"]] as const) {
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,$2,'personal',$3,$3)`,
      [spaceId, name, now],
    );
  }
  for (const userId of [OWNER, MEMBER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`,
      [userId, now],
    );
  }
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4), ($5,$2,$6,'member','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now, randomUUID(), MEMBER],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4), ($5,$6,NULL,'Elsewhere','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now, OTHER_PROJECT, OTHER_SPACE],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Agent','active',NULL,$4,$4,'space_shared')`,
    [AGENT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1','Test agent','{}'::jsonb,'{"adapter_type":"model_api"}'::jsonb,
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
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, enabled,
       capabilities_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'Provider','anthropic',true,'{}'::jsonb,'{"is_default":true}'::jsonb,$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
});

function service(): AutomationService {
  return new AutomationService(config, new PgAutomationRepository(db.pool));
}

describeWithPostgres("Automation × Project binding (real Postgres)", () => {
  it("joins an existing transaction for project-fenced create and update", async () => {
    if (!db.available) return;
    const client = await db.pool.connect();
    let automationId = "";
    try {
      await client.query("BEGIN");
      const repository = new PgAutomationRepository(client);
      const created = await repository.create({
        spaceId: SPACE,
        ownerUserId: OWNER,
        name: "Transactional automation",
        agentId: AGENT,
        projectId: PROJECT,
        triggerType: "manual",
        configJson: { target_type: "agent_run" },
        preflightSnapshot: {},
      });
      automationId = created.id;
      const updated = await repository.update(SPACE, created.id, { name: "Updated in transaction" });
      expect(updated.name).toBe("Updated in transaction");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const persisted = await db.pool.query(`SELECT 1 FROM automations WHERE id=$1`, [automationId]);
    expect(persisted.rows).toHaveLength(0);
  });

  it("creates a project-bound automation, exposes project_id, and clears it on update", async () => {
    if (!db.available) return;
    const created = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "Paper digest",
        agent_id: AGENT,
        project_id: PROJECT,
        trigger_type: "manual",
        config_json: { target_type: "agent_run" },
      },
    });
    expect(created.project_id).toBe(PROJECT);

    const fetched = await new PgAutomationRepository(db.pool).get(SPACE, created.id);
    expect(fetched?.project_id).toBe(PROJECT);

    const cleared = await service().update({
      spaceId: SPACE,
      automationId: created.id,
      actorUserId: OWNER,
      body: { project_id: null },
    });
    expect(cleared.project_id).toBeNull();

    const rebound = await service().update({
      spaceId: SPACE,
      automationId: created.id,
      actorUserId: OWNER,
      body: { project_id: PROJECT },
    });
    expect(rebound.project_id).toBe(PROJECT);
  });

  it("lists automations filtered by project_id", async () => {
    if (!db.available) return;
    const bound = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "Project digest",
        agent_id: AGENT,
        project_id: PROJECT,
        trigger_type: "manual",
        config_json: { target_type: "agent_run" },
      },
    });
    const unbound = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "General digest",
        agent_id: AGENT,
        trigger_type: "manual",
        config_json: { target_type: "agent_run" },
      },
    });

    const repo = new PgAutomationRepository(db.pool);
    await expect(repo.list(SPACE, { projectId: PROJECT })).resolves.toMatchObject([
      { id: bound.id, project_id: PROJECT },
    ]);
    await expect(repo.list(SPACE, { projectId: null })).resolves.toMatchObject([
      { id: unbound.id, project_id: null },
    ]);
  });

  it("rejects project binding for non-agent_run targets with 422", async () => {
    if (!db.available) return;
    await expect(
      service().create({
        spaceId: SPACE,
        ownerUserId: OWNER,
        body: {
          name: "Maintenance",
          agent_id: AGENT,
          project_id: PROJECT,
          trigger_type: "manual",
          config_json: { target_type: "knowledge_retrieval_maintenance" },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("requires project writer authority to bind: plain space member gets 403", async () => {
    if (!db.available) return;
    await expect(
      service().create({
        spaceId: SPACE,
        ownerUserId: MEMBER,
        body: {
          name: "Paper digest",
          agent_id: AGENT,
          project_id: PROJECT,
          trigger_type: "manual",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Becoming an active project member grants bind authority.
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
      [randomUUID(), SPACE, PROJECT, MEMBER, now],
    );
    const created = await service().create({
      spaceId: SPACE,
      ownerUserId: MEMBER,
      body: {
        name: "Paper digest",
        agent_id: AGENT,
        project_id: PROJECT,
        trigger_type: "manual",
      },
    });
    expect(created.project_id).toBe(PROJECT);
  });

  it("rejects binding a project from another space (404 from writer check)", async () => {
    if (!db.available) return;
    await expect(
      service().create({
        spaceId: SPACE,
        ownerUserId: OWNER,
        body: {
          name: "Cross-space",
          agent_id: AGENT,
          project_id: OTHER_PROJECT,
          trigger_type: "manual",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("database composite FK rejects a cross-space project even on direct insert", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await expect(
      db.pool.query(
        `INSERT INTO automations (
           id, space_id, owner_user_id, agent_id, project_id, name,
           trigger_type, status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'x','manual','active',$6,$6)`,
        [randomUUID(), SPACE, OWNER, AGENT, OTHER_PROJECT, now],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("fire creates the run with the automation's project_id", async () => {
    if (!db.available) return;
    const created = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "Paper digest",
        agent_id: AGENT,
        project_id: PROJECT,
        trigger_type: "manual",
        config_json: { target_type: "agent_run" },
      },
    });
    const result = await service().fire({
      spaceId: SPACE,
      automationId: created.id,
      actorUserId: OWNER,
      prompt: "Analyze new papers",
    });
    const run = await db.pool.query<{ project_id: string | null; trigger_origin: string }>(
      `SELECT project_id, trigger_origin FROM runs WHERE id = $1`,
      [String(result.run_id)],
    );
    expect(run.rows[0]?.project_id).toBe(PROJECT);
    expect(run.rows[0]?.trigger_origin).toBe("automation");
  });

  it("enforces an automation max_runs cap across direct fires", async () => {
    if (!db.available) return;
    const created = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "Single-fire automation",
        agent_id: AGENT,
        trigger_type: "manual",
        config_json: {
          target_type: "agent_run",
          contract_json: { max_runs: 1 },
        },
      },
    });
    await service().fire({ spaceId: SPACE, automationId: created.id, actorUserId: OWNER });
    await expect(
      service().fire({ spaceId: SPACE, automationId: created.id, actorUserId: OWNER }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const count = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM automation_runs WHERE automation_id = $1`,
      [created.id],
    );
    expect(count.rows[0]?.total).toBe("1");
  });

  it("checks every effective max_runs source and rejects Task admission before task_runs", async () => {
    if (!db.available) return;
    const automation = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "Inherited budget automation",
        agent_id: AGENT,
        trigger_type: "manual",
        config_json: { target_type: "agent_run", contract_json: { max_runs: 1 } },
      },
    });
    const fired = await service().fire({ spaceId: SPACE, automationId: automation.id, actorUserId: OWNER });

    const taskId = randomUUID();
    await db.pool.query(
      `INSERT INTO tasks (
         id, space_id, title, task_type, status, risk_level,
         created_by_user_id, owner_user_id, assigned_agent_id,
         policy_json, visibility, access_level, created_at, updated_at
       ) VALUES ($1, $2, 'Inherited budget task', 'general', 'inbox', 'low',
                 $3, $3, $4, $5::jsonb, 'space_shared', 'full', $6, $6)`,
      [
        taskId,
        SPACE,
        OWNER,
        AGENT,
        JSON.stringify({
          budget_sources: [{ source: { kind: "automation", id: automation.id }, max_runs: 1 }],
        }),
        new Date().toISOString(),
      ],
    );

    await expect(
      new PgTaskRepository(db.pool).createTaskRun(
        { spaceId: SPACE, userId: OWNER },
        taskId,
        { agent_id: AGENT },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "automation_max_runs_exceeded" });
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_runs WHERE space_id = $1 AND task_id = $2`,
      [SPACE, taskId],
    )).rows[0]?.count).toBe("0");

    await db.pool.query(
      `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
       VALUES ($1, $2, $3, $4, 'primary', $5)`,
      [randomUUID(), SPACE, taskId, String(fired.run_id), new Date().toISOString()],
    );
    const multiSource = [
      { source: { kind: "task" as const, id: taskId }, max_runs: 1 },
      { source: { kind: "automation" as const, id: automation.id }, max_runs: 1 },
    ];
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, multiSource)).rejects.toMatchObject({
      code: "task_max_runs_exceeded",
    });
    const dispatch = await checkRunBudget(db.pool, {
      id: randomUUID(),
      space_id: SPACE,
      root_run_id: null,
      contract_snapshot_json: {
        source: { kind: "task", id: taskId },
        budget_sources: multiSource,
      },
    } as Pick<RunRecord, "id" | "space_id" | "root_run_id" | "contract_snapshot_json">);
    expect(dispatch).toMatchObject({ allowed: false, error_code: "task_max_runs_exceeded" });
  });

  it("fails closed for missing sources and admits direct Workflow Runs atomically", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, description,
         owner_scope_type, status, metadata_json, created_at, updated_at
       ) VALUES ($1, NULL, 'workflow_template', 'workflow.budget-test', 'Budget workflow',
                 'Budget workflow', 'system', 'active', '{}'::jsonb, $2, $2)`,
      [WORKFLOW_ASSET, now],
    );
    await db.pool.query(
      `INSERT INTO evolvable_asset_versions (
         id, asset_id, space_id, scope_type, version, status, source,
         content_hash, content_json, created_at, updated_at
       ) VALUES ($1, $2, NULL, 'system', 1, 'approved', 'built_in', 'budget-test', '{}'::jsonb, $3, $3)`,
      [WORKFLOW_VERSION, WORKFLOW_ASSET, now],
    );

    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "automation", id: randomUUID() }, max_runs: 1 },
    ])).rejects.toMatchObject({ code: "budget_source_not_found" });
    const invalidDispatch = await checkRunBudget(db.pool, {
      id: randomUUID(),
      space_id: SPACE,
      root_run_id: null,
      contract_snapshot_json: {
        source: { kind: "automation", id: randomUUID() },
        budget_sources: [{ source: { kind: "automation", id: randomUUID() }, max_runs: 1 }],
      },
    } as Pick<RunRecord, "id" | "space_id" | "root_run_id" | "contract_snapshot_json">);
    expect(invalidDispatch).toMatchObject({ allowed: false, error_code: "budget_source_not_found" });

    const repo = new PgRunRepository(db.pool);
    const input = {
      agent_id: AGENT,
      space_id: SPACE,
      user_id: OWNER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Run the bounded workflow",
      workflow_version_id: WORKFLOW_VERSION,
      contract_snapshot: {
        source: { kind: "workflow" as const, id: WORKFLOW_VERSION },
        max_runs: 1,
      },
    };
    const first = await repo.createQueuedRunWithBudgetAdmission(input);
    expect(first.workflow_version_id).toBe(WORKFLOW_VERSION);
    await expect(repo.createQueuedRunWithBudgetAdmission(input)).rejects.toMatchObject({
      code: "workflow_max_runs_exceeded",
    });
    const runs = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM runs WHERE space_id = $1`,
      [SPACE],
    );
    expect(runs.rows[0]?.count).toBe("1");

    await db.pool.query(`UPDATE evolvable_assets SET status = 'disabled' WHERE id = $1`, [WORKFLOW_ASSET]);
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "workflow", id: WORKFLOW_VERSION }, max_runs: 1 },
    ])).rejects.toMatchObject({ code: "budget_source_not_found" });
    await db.pool.query(`UPDATE evolvable_assets SET status = 'active' WHERE id = $1`, [WORKFLOW_ASSET]);
    await db.pool.query(
      `UPDATE evolvable_asset_versions SET scope_type = 'space', scope_id = $2 WHERE id = $1`,
      [WORKFLOW_VERSION, SPACE],
    );
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "workflow", id: WORKFLOW_VERSION }, max_runs: 1 },
    ])).rejects.toMatchObject({ code: "budget_source_not_found" });
  });

  it("rejects a space-scoped Workflow budget source that belongs to another space", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const otherAsset = randomUUID();
    const otherVersion = randomUUID();
    await db.pool.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, description,
         owner_scope_type, status, metadata_json, created_at, updated_at
       ) VALUES ($1, $2, 'workflow_template', 'workflow.other-space', 'Other space workflow',
                 'Other space workflow', 'space', 'active', '{}'::jsonb, $3, $3)`,
      [otherAsset, OTHER_SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO evolvable_asset_versions (
         id, asset_id, space_id, scope_type, scope_id, version, status, source,
         content_hash, content_json, created_at, updated_at
       ) VALUES ($1, $2, $3, 'space', $3, 1, 'approved', 'built_in', 'other-space-budget-test', '{}'::jsonb, $4, $4)`,
      [otherVersion, otherAsset, OTHER_SPACE, now],
    );

    // Approved, active, and correctly scoped — but only within OTHER_SPACE.
    // A caller in SPACE must never admit against it, and a caller in
    // OTHER_SPACE must be able to.
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "workflow", id: otherVersion }, max_runs: 1 },
    ])).rejects.toMatchObject({ code: "budget_source_not_found" });
    await expect(assertBudgetSourcesAvailable(db.pool, OTHER_SPACE, [
      { source: { kind: "workflow", id: otherVersion }, max_runs: 1 },
    ])).resolves.toBeUndefined();

    await db.pool.query(
      `UPDATE evolvable_asset_versions
          SET scope_type = 'system', scope_id = NULL
        WHERE id = $1`,
      [otherVersion],
    );
    await expect(assertBudgetSourcesAvailable(db.pool, OTHER_SPACE, [
      { source: { kind: "workflow", id: otherVersion }, max_runs: 1 },
    ])).resolves.toBeUndefined();
  });

  it("rejects a Workflow Version whose scope is forbidden by its parent Asset ownership", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const privateAsset = randomUUID();
    const mismatchedVersion = randomUUID();
    await db.pool.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, description,
         owner_scope_type, owner_scope_id, status, metadata_json, created_at, updated_at
       ) VALUES ($1, $2, 'workflow_template', 'workflow.private-scope', 'Private workflow',
                 'Private workflow', 'user', $3, 'active', '{}'::jsonb, $4, $4)`,
      [privateAsset, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO evolvable_asset_versions (
         id, asset_id, space_id, scope_type, scope_id, version, status, source,
         content_hash, content_json, created_at, updated_at
       ) VALUES ($1, $2, $3, 'space', $3, 1, 'approved', 'user_authored',
                 'private-scope-budget-test', '{}'::jsonb, $4, $4)`,
      [mismatchedVersion, privateAsset, SPACE, now],
    );

    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "workflow", id: mismatchedVersion }, max_runs: 1 },
    ])).rejects.toMatchObject({ code: "budget_source_not_found" });

    await db.pool.query(
      `UPDATE evolvable_asset_versions
          SET scope_type = 'user', scope_id = $2
        WHERE id = $1`,
      [mismatchedVersion, OWNER],
    );
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "workflow", id: mismatchedVersion }, max_runs: 1 },
    ])).resolves.toBeUndefined();

    await db.pool.query(
      `UPDATE evolvable_assets
          SET owner_scope_type = 'space', owner_scope_id = NULL
        WHERE id = $1`,
      [privateAsset],
    );
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "workflow", id: mismatchedVersion }, max_runs: 1 },
    ])).rejects.toMatchObject({ code: "budget_source_not_found" });

    await db.pool.query(
      `UPDATE evolvable_assets
          SET metadata_json = '{"allow_user_override":true}'::jsonb
        WHERE id = $1`,
      [privateAsset],
    );
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [
      { source: { kind: "workflow", id: mismatchedVersion }, max_runs: 1 },
    ])).resolves.toBeUndefined();
  });

  it("resolves a pinned workflow target and launches one execution with bounded input", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const definition = {
      schema_version: "workflow_definition.v1",
      workflow_id: "workflow.automation-test",
      name: "Automation workflow",
      description: "A deterministic workflow target.",
      input_schema_json: { type: "object" },
      output_artifact_types: [],
      nodes: [{
        id: "step_one",
        title: "Step one",
        depends_on: [],
        capability_id: "research.search",
        prompt_asset_key: null,
        agent_id: null,
        runtime_profile_id: null,
        verification_recipe_refs: [],
        approval_checkpoint: { required: false, proposal_type: null },
        contract_json: {
          risk_level: "low",
          max_attempts: 1,
          required_outputs_json: [{ type: "output_schema", schema: { type: "object" } }],
        },
        metadata_json: { runtime_delegation_allowed: false },
      }],
      metadata_json: {
        budget_cap: 1,
        primary_objective: "Run the bounded automation workflow.",
        scope_json: { inputs: ["query"] },
      },
    };
    await db.pool.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, description,
         owner_scope_type, status, metadata_json, created_at, updated_at
       ) VALUES ($1,NULL,'workflow_template','workflow.automation-test','Automation workflow',$2,'system','active','{}'::jsonb,$3,$3)`,
      [WORKFLOW_ASSET, definition.description, now],
    );
    await db.pool.query(
      `INSERT INTO evolvable_asset_versions (
         id, asset_id, space_id, scope_type, version, status, source,
         content_hash, content_json, created_at, updated_at
       ) VALUES ($1,$2,NULL,'system',1,'approved','built_in','automation-test',$3::jsonb,$4,$4)`,
      [WORKFLOW_VERSION, WORKFLOW_ASSET, JSON.stringify(definition), now],
    );
    await db.pool.query(
      `UPDATE evolvable_assets SET current_system_version_id = $2 WHERE id = $1`,
      [WORKFLOW_ASSET, WORKFLOW_VERSION],
    );

    const automation = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "Workflow automation",
        agent_id: AGENT,
        project_id: PROJECT,
        config_json: {
          target_type: "workflow",
          workflow_asset_key: "workflow.automation-test",
          workflow_resolution: "pin",
          input_json: { query: "bounded" },
          contract_json: { max_runs: 1 },
        },
      },
    });
    expect(automation.config_json).toMatchObject({
      target_type: "workflow",
      workflow_resolution: "pin",
      workflow_version_id: WORKFLOW_VERSION,
    });

    const fired = await service().fire({
      spaceId: SPACE,
      automationId: automation.id,
      actorUserId: OWNER,
    });
    expect(fired).toMatchObject({ target_type: "workflow", workflow_version_id: WORKFLOW_VERSION });
    const execution = await db.pool.query<{ status: string; input_json: Record<string, unknown> }>(
      `SELECT status, input_json FROM workflow_executions WHERE id = $1`,
      [String(fired.workflow_execution_id)],
    );
    expect(execution.rows[0]?.status).toBe("running");
    expect(execution.rows[0]?.input_json).toMatchObject({ query: "bounded" });
    const root = await db.pool.query<{ trigger_origin: string; workflow_input_json: Record<string, unknown> }>(
      `SELECT trigger_origin, contract_snapshot_json->'workflow_input_json' AS workflow_input_json FROM runs WHERE id = $1`,
      [String(fired.root_run_id)],
    );
    expect(root.rows[0]).toMatchObject({
      trigger_origin: "automation",
      workflow_input_json: { query: "bounded" },
    });
    await expect(
      service().fire({ spaceId: SPACE, automationId: automation.id, actorUserId: OWNER }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const linkedBeforeArchive = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
        WHERE node.space_id=$1 AND node.execution_id=$2`,
      [SPACE, String(fired.workflow_execution_id)],
    );
    await new PgProjectRepository(db.pool).archive({ spaceId: SPACE, userId: OWNER }, PROJECT);
    await expect(new WorkflowExecutionService(config).reconcile(
      db.pool, SPACE, String(fired.workflow_execution_id), OWNER,
    )).rejects.toMatchObject({ statusCode: 409 });
    const stopped = await db.pool.query<{ execution_status: string; linked_runs: number }>(
      `SELECT execution.status AS execution_status,
              count(link.id)::int AS linked_runs
         FROM workflow_executions execution
         LEFT JOIN workflow_execution_nodes node
           ON node.space_id=execution.space_id AND node.execution_id=execution.id
         LEFT JOIN workflow_execution_node_runs link
           ON link.space_id=node.space_id AND link.node_id=node.id
        WHERE execution.space_id=$1 AND execution.id=$2
        GROUP BY execution.status`,
      [SPACE, String(fired.workflow_execution_id)],
    );
    expect(stopped.rows[0]).toEqual({
      execution_status: "cancelled",
      linked_runs: linkedBeforeArchive.rows[0]!.count,
    });
    const terminal = await db.pool.query<{
      root_status: string;
      node_statuses: string[];
      child_statuses: string[];
      job_statuses: string[];
    }>(
      `SELECT
         (SELECT status FROM runs WHERE id=$3) AS root_status,
         ARRAY(SELECT status FROM workflow_execution_nodes WHERE space_id=$1 AND execution_id=$2 ORDER BY id) AS node_statuses,
         ARRAY(
           SELECT run.status
             FROM workflow_execution_node_runs link
             JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
             JOIN runs run ON run.id=link.run_id AND run.space_id=link.space_id
            WHERE node.space_id=$1 AND node.execution_id=$2 ORDER BY run.id
         ) AS child_statuses,
         ARRAY(
           SELECT job.status FROM jobs job
            WHERE job.space_id=$1
              AND job.payload_json->>'workflow_execution_id'=$2
            ORDER BY job.id
         ) AS job_statuses`,
      [SPACE, String(fired.workflow_execution_id), String(fired.root_run_id)],
    );
    expect(terminal.rows[0]?.root_status).toBe("cancelled");
    expect(terminal.rows[0]?.node_statuses).toEqual(["blocked"]);
    expect(terminal.rows[0]?.child_statuses).toEqual(["cancelled"]);
    expect(terminal.rows[0]?.job_statuses).toEqual(["cancelled"]);
  });

  it("rejects follow resolution for unattended workflow triggers", async () => {
    if (!db.available) return;
    await expect(
      service().create({
        spaceId: SPACE,
        ownerUserId: OWNER,
        body: {
          name: "Unattended workflow",
          agent_id: AGENT,
          trigger_type: "schedule",
          config_json: {
            target_type: "workflow",
            workflow_asset_key: "workflow.automation-test",
            workflow_resolution: "follow",
            cron: "*/5 * * * *",
          },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects source event automations", async () => {
    if (!db.available) return;
    await expect(
      service().create({
        spaceId: SPACE,
        ownerUserId: OWNER,
        body: {
          name: "Bad event",
          agent_id: AGENT,
          project_id: PROJECT,
          trigger_type: "event",
          config_json: { target_type: "agent_run" },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("fire preflight fails when the bound project was soft-deleted after binding", async () => {
    if (!db.available) return;
    const created = await service().create({
      spaceId: SPACE,
      ownerUserId: OWNER,
      body: {
        name: "Paper digest",
        agent_id: AGENT,
        project_id: PROJECT,
        trigger_type: "manual",
      },
    });
    await db.pool.query(`UPDATE projects SET deleted_at = NOW(), status = 'deleted' WHERE id = $1`, [PROJECT]);
    await expect(
      service().fire({
        spaceId: SPACE,
        automationId: created.id,
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
