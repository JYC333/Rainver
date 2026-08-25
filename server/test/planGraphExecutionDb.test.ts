import { beforeEach, describe, expect, inject, it } from "vitest";
import { randomUUID } from "node:crypto";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { PgPlanRepository } from "../src/modules/plans/repository";
import { PgProposalApplyService } from "../src/modules/proposals/applyService";
import { PgRunRepository } from "../src/modules/runs/repository";
import { canonicalRunOutput } from "../src/modules/runs/orchestrationResults";
import { PgTaskRepository } from "../src/modules/tasks/repository";
import { PgAutomationRepository } from "../src/modules/automations/repository";
import { assertBudgetSourcesAvailable } from "../src/modules/runs/budgetEnforcement";
import { WorkflowExecutionService } from "../src/modules/automations/workflowExecutionService";
import { actionNodeHandlerRegistry, ActionNodeHandlerError } from "../src/modules/automations/actionNodeRegistry";
import { withQueryableTransaction, type SpaceUserIdentity } from "../src/modules/routeUtils/common";
import type { RunBudgetSource } from "../src/modules/runs/contractSnapshot";

const CONFIG = loadConfig({});
const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const AGENT_VERSION = "44444444-4444-4444-8444-444444444444";
const TASK = "77777777-7777-4777-8777-777777777777";
const AUTOMATION = "88888888-8888-4888-8888-888888888888";
const WORKFLOW_ASSET = "99999999-9999-4999-8999-999999999999";
const FIXED_WORKFLOW_VERSION = "workflow-version-fixed-1";
const BINDING_WORKFLOW_VERSION = "workflow-version-bindings";

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: USER };
const sharedPostgres = inject("sharedPostgres");
const describeWithPostgres = describe.skipIf(
  !sharedPostgres.available || !sharedPostgres.adminUri || !sharedPostgres.templateDatabase || !sharedPostgres.runId,
);

const db = useTestDatabase(__filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Plan Test User', 'active', $2, $2)`,
    [USER, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Plan Test Space', 'team', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    ["66666666-6666-4666-8666-666666666666", SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO evolvable_assets (
       id, space_id, asset_type, asset_key, display_name, owner_scope_type,
       owner_scope_id, status, metadata_json, created_at, updated_at
     ) VALUES ($1, $2, 'workflow_template', 'plan-graph-test', 'Plan graph test',
               'space', $2, 'active', '{}'::jsonb, $3, $3)`,
    [WORKFLOW_ASSET, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO evolvable_asset_versions (
       id, asset_id, space_id, scope_type, scope_id, version, status, source,
       content_json, created_at, updated_at
     ) VALUES
       ($1, $3, $4, 'space', $4, 1, 'approved', 'user_authored', '{}'::jsonb, $5, $5),
       ($2, $3, $4, 'space', $4, 2, 'approved', 'user_authored', '{}'::jsonb, $5, $5)`,
    [FIXED_WORKFLOW_VERSION, BINDING_WORKFLOW_VERSION, WORKFLOW_ASSET, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id,
                         created_at, updated_at, visibility)
     VALUES ($1, $2, $3, 'Plan Test Agent', 'active', NULL, $4, $4, 'space_shared')`,
    [AGENT, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'You are a test agent.',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '[]'::jsonb, '{"allowed_tools":["task.plan.propose"]}'::jsonb,
               '{}'::jsonb, $4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Default', 'model_api', '{"adapter_type":"model_api"}'::jsonb,
       '{}'::jsonb, true, true, $4, $4)`,
    [randomUUID(), SPACE, AGENT, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1 AND space_id = $3`, [AGENT, AGENT_VERSION, SPACE]);
});

function agentPlanDefinition() {
  return {
    schema_version: "workflow_definition.v1",
    workflow_id: "agent-plan-db-test",
    name: "Agent generated plan",
    description: "A plan produced from a planning Run.",
    input_schema_json: {},
    output_artifact_types: [],
    metadata_json: {
      primary_objective: "Complete the source task.",
      scope_json: { inputs: ["source task contract"] },
    },
    nodes: [{
      id: "work",
      title: "Complete the task",
      depends_on: [],
      capability_id: "task-work",
      verification_recipe_refs: ["output-check"],
      contract_json: { risk_level: "high", max_runs: 1, max_attempts: 2 },
      metadata_json: { runtime_delegation_allowed: false },
    }],
  };
}

async function seedBudgetAutomation(): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO automations (
       id, space_id, owner_user_id, agent_id, name, trigger_type, status,
       config_json, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Shared budget automation', 'manual', 'active', '{}'::jsonb, $5, $5)`,
    [AUTOMATION, SPACE, USER, AGENT, now],
  );
}

async function createApprovedPlanWithBudget(
  budgetSources: RunBudgetSource[],
): Promise<{ plans: PgPlanRepository; planId: string; versionId: string }> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO tasks (
       id, space_id, task_role, title, description, task_type, status, priority,
       risk_level, owner_user_id, visibility, access_level, created_by_user_id,
       created_at, updated_at
     ) VALUES ($1, $2, 'source', 'Budget source task', 'Task with an inherited budget.', 'general',
               'inbox', 'normal', 'medium', $3, 'space_shared', 'full', $3, $4, $4)`,
    [TASK, SPACE, USER, now],
  );
  const planningRun = await new PgTaskRepository(db.pool).requestPlanningRun(identity, TASK, {
    agent_id: AGENT,
    prompt: "Plan this source task.",
  }) as { id: string };
  await db.pool.query(
    `UPDATE runs
        SET contract_snapshot_json = jsonb_set(
          contract_snapshot_json,
          '{policy_context_json}',
          jsonb_build_object('plan_budget_sources', $3::jsonb),
          true
        )
      WHERE space_id = $1 AND id = $2`,
    [SPACE, planningRun.id, JSON.stringify(budgetSources)],
  );
  const plans = new PgPlanRepository(db.pool);
  const created = await plans.createPlanFromAgent(identity, {
    sourceTaskId: TASK,
    planningRunId: planningRun.id,
    planningToolCallId: `tool-call-budget-${randomUUID()}`,
    agentId: AGENT,
    definitionJson: agentPlanDefinition(),
    budgetCap: 100,
  });
  const version = created.current_version as { id: string; approval_proposal_id: string };
  const apply = PgProposalApplyService.fromConfig(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_INTERNAL_TOKEN: "test-internal-token",
  }));
  await apply.accept(version.approval_proposal_id, identity);
  return { plans, planId: String(created.id), versionId: version.id };
}

describeWithPostgres("Task to Agent Plan real PostgreSQL lifecycle", () => {
  it("does not create a Plan for a source Task until an Agent planning Run proposes it", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO tasks (
         id, space_id, task_role, title, description, task_type, status, priority,
         risk_level, owner_user_id, visibility, access_level, created_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, 'source', 'Source task', 'Task requiring a plan.', 'general',
                 'inbox', 'normal', 'medium', $3, 'space_shared', 'full', $3, $4, $4)`,
      [TASK, SPACE, USER, now],
    );

    expect((await db.pool.query(`SELECT count(*)::int AS count FROM plans WHERE space_id = $1`, [SPACE])).rows[0]?.count).toBe(0);

    const taskRepository = new PgTaskRepository(db.pool);
    const planningRun = await taskRepository.requestPlanningRun(identity, TASK, {
      agent_id: AGENT,
      prompt: "Plan this source task.",
    }) as { id: string; run_type: string };
    expect(planningRun.run_type).toBe("planning");
    expect((await db.pool.query(
      `SELECT role FROM task_runs WHERE space_id = $1 AND task_id = $2 AND run_id = $3`,
      [SPACE, TASK, planningRun.id],
    )).rows[0]?.role).toBe("planning");

    const plans = new PgPlanRepository(db.pool);
    const first = await plans.createPlanFromAgent(identity, {
      sourceTaskId: TASK,
      planningRunId: planningRun.id,
      planningToolCallId: "tool-call-1",
      agentId: AGENT,
      definitionJson: agentPlanDefinition(),
      budgetCap: 100,
    });
    expect(first).toMatchObject({ source_task_id: TASK, created_by_agent_id: AGENT, status: "pending_review" });
    const firstVersion = first.current_version as { id: string; status: string; approval_proposal_id: string | null; nodes: unknown[] };
    expect(firstVersion.status).toBe("pending_review");
    expect(firstVersion.approval_proposal_id).toBeTruthy();
    expect(firstVersion.nodes).toHaveLength(1);

    const replay = await plans.createPlanFromAgent(identity, {
      sourceTaskId: TASK,
      planId: String(first.id),
      planningRunId: planningRun.id,
      planningToolCallId: "tool-call-1",
      agentId: AGENT,
      definitionJson: agentPlanDefinition(),
      budgetCap: 100,
    });
    expect(replay.id).toBe(first.id);
    expect((await db.pool.query(`SELECT count(*)::int AS count FROM plan_versions WHERE plan_id = $1`, [first.id])).rows[0]?.count).toBe(1);

    const apply = PgProposalApplyService.fromConfig(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_INTERNAL_TOKEN: "test-internal-token",
    }));
    const reviewed = await apply.accept(firstVersion.approval_proposal_id!, identity);
    expect(reviewed?.proposal.status).toBe("accepted");

    const executed = await plans.executePlan(identity, String(first.id), { agentId: AGENT });
    expect(executed.scheduled_node_ids).toHaveLength(1);
    const nodeRun = (await db.pool.query<{ node_id: string; run_id: string }>(
      `SELECT pnr.plan_node_id AS node_id, pnr.run_id
         FROM plan_node_runs pnr JOIN plan_nodes n ON n.id = pnr.plan_node_id
        WHERE pnr.space_id = $1 AND n.plan_version_id = $2`,
      [SPACE, firstVersion.id],
    )).rows[0];
    expect(nodeRun).toBeTruthy();
    expect((await db.pool.query(`SELECT count(*)::int AS count FROM tasks WHERE space_id = $1 AND id <> $2`, [SPACE, TASK])).rows[0]?.count).toBe(0);

    const runs = new PgRunRepository(db.pool);
    const planArtifactId = randomUUID();
    await db.pool.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, artifact_type, title, export_formats_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'result', 'Plan result', '[]'::jsonb, $4, $4)`,
      [planArtifactId, SPACE, nodeRun!.run_id, now],
    );
    await runs.markRunRunning({ run_id: nodeRun!.run_id, space_id: SPACE, started_at: new Date().toISOString() });
    await runs.markRunTerminal({
      run_id: nodeRun!.run_id,
      space_id: SPACE,
      status: "succeeded",
      output_json: canonicalRunOutput({
        success: true,
        outputText: "done",
        outputJson: {
          result: "done",
          materialization: [{ kind: "artifact", status: "succeeded", artifact_id: planArtifactId }],
        },
      }),
      completed_at: new Date().toISOString(),
    });
    await runs.insertRunEvaluation({
      space_id: SPACE,
      run_id: nodeRun!.run_id,
      outcome_status: "passed",
      trajectory_status: "acceptable",
      evaluated_at: new Date().toISOString(),
    });
    const reconciled = await plans.reconcilePlan(identity, String(first.id));
    expect(reconciled.status).toBe("completed");
    expect((await db.pool.query<{ status: string }>(`SELECT status FROM plan_nodes WHERE id = $1`, [nodeRun!.node_id])).rows[0]?.status).toBe("done");
  });

  it("rejects an Agent plan proposal whose node declares a budget source that does not exist", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO tasks (
         id, space_id, task_role, title, description, task_type, status, priority,
         risk_level, owner_user_id, visibility, access_level, created_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, 'source', 'Source task', 'Task requiring a plan.', 'general',
                 'inbox', 'normal', 'medium', $3, 'space_shared', 'full', $3, $4, $4)`,
      [TASK, SPACE, USER, now],
    );
    const taskRepository = new PgTaskRepository(db.pool);
    const planningRun = await taskRepository.requestPlanningRun(identity, TASK, {
      agent_id: AGENT,
      prompt: "Plan this source task.",
    }) as { id: string };

    const plans = new PgPlanRepository(db.pool);
    const definition = agentPlanDefinition();
    (definition.nodes[0] as { contract_json: Record<string, unknown> }).contract_json = {
      ...(definition.nodes[0] as { contract_json: Record<string, unknown> }).contract_json,
      budget_sources: [{ source: { kind: "automation", id: randomUUID() }, max_runs: 1 }],
    };
    await expect(plans.createPlanFromAgent(identity, {
      sourceTaskId: TASK,
      planningRunId: planningRun.id,
      planningToolCallId: "tool-call-missing-node-budget",
      agentId: AGENT,
      definitionJson: definition,
      budgetCap: 100,
    })).rejects.toMatchObject({ code: "budget_source_not_found" });
    expect((await db.pool.query(`SELECT count(*)::int AS count FROM plans WHERE space_id = $1`, [SPACE])).rows[0]?.count).toBe(0);
  });

  it("fails closed when a Plan node's declared budget source is already exhausted, leaving no queued Run or plan_node_runs row", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO automations (
         id, space_id, owner_user_id, agent_id, name, trigger_type, status,
         config_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Shared budget automation', 'manual', 'active', '{}'::jsonb, $5, $5)`,
      [AUTOMATION, SPACE, USER, AGENT, now],
    );
    // Consume the Automation's single admitted slot with an unrelated direct
    // Run, the same way a manual fire would, before the Plan node ever tries
    // to inherit that budget.
    const runs = new PgRunRepository(db.pool);
    const consumedRun = await runs.createQueuedRun({
      agent_id: AGENT,
      space_id: SPACE,
      user_id: USER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Consume the automation's one admitted slot.",
    });
    await new PgAutomationRepository(db.pool).createAutomationRun({
      automationId: AUTOMATION,
      runId: consumedRun.id,
      triggeredByUserId: USER,
      triggerType: "manual",
      preflightSnapshot: { executable: true },
    });

    await db.pool.query(
      `INSERT INTO tasks (
         id, space_id, task_role, title, description, task_type, status, priority,
         risk_level, owner_user_id, visibility, access_level, created_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, 'source', 'Budget source task', 'Task with an exhausted node budget.', 'general',
                 'inbox', 'normal', 'medium', $3, 'space_shared', 'full', $3, $4, $4)`,
      [TASK, SPACE, USER, now],
    );
    const taskRepository = new PgTaskRepository(db.pool);
    const planningRun = await taskRepository.requestPlanningRun(identity, TASK, {
      agent_id: AGENT,
      prompt: "Plan this source task.",
    }) as { id: string };

    const plans = new PgPlanRepository(db.pool);
    const definition = agentPlanDefinition();
    (definition.nodes[0] as { contract_json: Record<string, unknown> }).contract_json = {
      ...(definition.nodes[0] as { contract_json: Record<string, unknown> }).contract_json,
      budget_sources: [{ source: { kind: "automation", id: AUTOMATION }, max_runs: 1 }],
    };
    const created = await plans.createPlanFromAgent(identity, {
      sourceTaskId: TASK,
      planningRunId: planningRun.id,
      planningToolCallId: "tool-call-exhausted-node-budget",
      agentId: AGENT,
      definitionJson: definition,
      budgetCap: 100,
    });
    const version = created.current_version as { id: string; approval_proposal_id: string };
    expect(version.approval_proposal_id).toBeTruthy();

    const apply = PgProposalApplyService.fromConfig(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_INTERNAL_TOKEN: "test-internal-token",
    }));
    await apply.accept(version.approval_proposal_id, identity);

    await expect(plans.executePlan(identity, String(created.id), { agentId: AGENT })).rejects.toMatchObject({
      code: "automation_max_runs_exceeded",
    });

    // The rejected node admission must roll back the whole execute attempt:
    // no coordinator Run, no child Run, and no plan_node_runs link survive.
    const plan = (await db.pool.query<{ status: string; root_run_id: string | null }>(
      `SELECT status, root_run_id FROM plans WHERE id = $1`,
      [created.id],
    )).rows[0];
    expect(plan).toMatchObject({ status: "active", root_run_id: null });
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM plan_node_runs
        WHERE plan_node_id IN (SELECT id FROM plan_nodes WHERE plan_version_id = $1)`,
      [version.id],
    )).rows[0]?.count).toBe(0);
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM runs WHERE space_id = $1`,
      [SPACE],
    )).rows[0]?.count).toBe(2);
  });

  it("inherits a Plan-level budget into child Runs and consumes the source as one logical execution", async () => {
    if (!db.available) return;
    await seedBudgetAutomation();
    const source: RunBudgetSource = {
      source: { kind: "automation", id: AUTOMATION },
      max_runs: 1,
    };
    const { plans, planId, versionId } = await createApprovedPlanWithBudget([source]);

    const executed = await plans.executePlan(identity, planId, { agentId: AGENT });
    expect(executed.scheduled_node_ids).toHaveLength(1);
    const child = (await db.pool.query<{ root_run_id: string; contract_snapshot_json: { budget_sources: RunBudgetSource[] } }>(
      `SELECT r.root_run_id, r.contract_snapshot_json
         FROM runs r
         JOIN plan_node_runs pnr ON pnr.run_id = r.id AND pnr.space_id = r.space_id
         JOIN plan_nodes n ON n.id = pnr.plan_node_id AND n.space_id = pnr.space_id
        WHERE n.plan_version_id = $1`,
      [versionId],
    )).rows[0];
    expect(child?.root_run_id).toBe(executed.root_run_id);
    expect(child?.contract_snapshot_json.budget_sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: { kind: "automation", id: AUTOMATION }, max_runs: 1 }),
    ]));
    await expect(assertBudgetSourcesAvailable(db.pool, SPACE, [source])).rejects.toMatchObject({
      code: "automation_max_runs_exceeded",
    });
  });

  it("serializes concurrent manual and Plan admission against one inherited Automation budget", async () => {
    if (!db.available) return;
    await seedBudgetAutomation();
    const source: RunBudgetSource = {
      source: { kind: "automation", id: AUTOMATION },
      max_runs: 1,
    };
    const { plans, planId, versionId } = await createApprovedPlanWithBudget([source]);

    const manualAdmission = () => withQueryableTransaction(db.pool, async (client) => {
      await assertBudgetSourcesAvailable(client, SPACE, [source]);
      const run = await new PgRunRepository(client).createQueuedRun({
        agent_id: AGENT,
        space_id: SPACE,
        user_id: USER,
        mode: "live",
        run_type: "agent",
        trigger_origin: "manual",
        prompt: "Compete with Plan admission.",
        contract_snapshot: {
          source: { kind: "automation", id: AUTOMATION },
          max_runs: 1,
        },
      });
      await new PgAutomationRepository(client).createAutomationRun({
        automationId: AUTOMATION,
        runId: run.id,
        triggeredByUserId: USER,
        triggerType: "manual",
        preflightSnapshot: { executable: true },
      });
      return run.id;
    });
    const outcomes = await Promise.allSettled([
      manualAdmission(),
      plans.executePlan(identity, planId, { agentId: AGENT }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejection?.reason).toMatchObject({ code: "automation_max_runs_exceeded" });
    const automationRuns = (await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM automation_runs WHERE automation_id = $1`,
      [AUTOMATION],
    )).rows[0]?.count ?? 0;
    const planNodeRuns = (await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM plan_node_runs pnr
         JOIN plan_nodes n ON n.id = pnr.plan_node_id AND n.space_id = pnr.space_id
        WHERE n.plan_version_id = $1`,
      [versionId],
    )).rows[0]?.count ?? 0;
    expect(automationRuns + planNodeRuns).toBe(1);
  });

  it("executes a fixed Workflow through Workflow Execution without creating a Plan", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO automations (
         id, space_id, owner_user_id, agent_id, name, trigger_type, status,
         config_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Fixed workflow automation', 'manual', 'active', $5::jsonb, $6, $6)`,
      [AUTOMATION, SPACE, USER, AGENT, JSON.stringify({ target_type: "workflow" }), now],
    );
    const service = new WorkflowExecutionService(CONFIG);
    const execution = await service.start({
      db: db.pool,
      identity,
      automation: {
        id: AUTOMATION,
        space_id: SPACE,
        owner_user_id: USER,
        agent_id: AGENT,
        project_folder_id: null,
        project_id: null,
        name: "Fixed workflow automation",
        description: null,
        trigger_type: "manual",
        status: "active",
        preflight_snapshot_json: null,
        config_json: { target_type: "workflow" },
        next_run_at: null,
        last_fired_at: null,
        created_at: now,
        updated_at: now,
      },
      target: {
        versionId: FIXED_WORKFLOW_VERSION,
        resolutionTrace: [`pin:${FIXED_WORKFLOW_VERSION}`],
        contentJson: {
          schema_version: "workflow_definition.v1",
          workflow_id: "fixed-workflow-db-test",
          name: "Fixed workflow",
          description: "A workflow execution independent of Plans.",
          input_schema_json: {},
          output_artifact_types: [],
          metadata_json: {},
          nodes: [
            { id: "work", title: "Run workflow work", depends_on: [], capability_id: "workflow-work", contract_json: {}, metadata_json: {} },
            {
              id: "consume",
              title: "Consume workflow output",
              depends_on: ["work"],
              capability_id: "workflow-consume",
              input_bindings: [
                { name: "summary", from_node: "work", source: "output_text" },
                { name: "answer", from_node: "work", source: "output_json", json_pointer: "/result/answer" },
                { name: "report", from_node: "work", source: "artifact", artifact_type: "report" },
              ],
              contract_json: {},
              metadata_json: {},
            },
            { id: "checkpoint", title: "Approve workflow result", depends_on: ["consume"], approval_checkpoint: { required: true, proposal_type: "workflow_execution_checkpoint" }, contract_json: {}, metadata_json: {} },
          ],
        },
      },
      triggerType: "manual",
      inputJson: {},
      preflightSnapshot: { executable: true },
      budgetSources: [],
    });
    expect((await db.pool.query(`SELECT count(*)::int AS count FROM plans WHERE space_id = $1`, [SPACE])).rows[0]?.count).toBe(0);
    expect((await db.pool.query<{
      run_role: string;
      runtime_profile_id: string | null;
      adapter_type: string | null;
      attempt_count: number;
    }>(
      `SELECT root.run_role, root.runtime_profile_id, root.adapter_type,
              count(attempt.id)::int AS attempt_count
         FROM runs root
         LEFT JOIN run_attempts attempt ON attempt.run_id = root.id AND attempt.space_id = root.space_id
        WHERE root.space_id = $1 AND root.id = $2
        GROUP BY root.id`,
      [SPACE, execution.rootRunId],
    )).rows[0]).toEqual({
      run_role: "coordinator",
      runtime_profile_id: null,
      adapter_type: null,
      attempt_count: 0,
    });
    await new PgAutomationRepository(db.pool).createAutomationRun({
      automationId: AUTOMATION,
      runId: execution.rootRunId,
      workflowExecutionId: execution.workflowExecutionId,
      triggeredByUserId: USER,
      triggerType: "manual",
      preflightSnapshot: { executable: true },
    });

    const work = (await db.pool.query<{ node_id: string; run_id: string }>(
      `SELECT wr.node_id, wr.run_id FROM workflow_execution_node_runs wr
        JOIN workflow_execution_nodes n ON n.id = wr.node_id
       WHERE wr.space_id = $1 AND n.execution_id = $2 AND n.node_key = 'work'`,
      [SPACE, execution.workflowExecutionId],
    )).rows[0];
    expect(work).toBeTruthy();
    const runs = new PgRunRepository(db.pool);
    const artifactId = randomUUID();
    await db.pool.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, artifact_type, title, export_formats_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'report', 'Workflow report', '[]'::jsonb, $4, $4)`,
      [artifactId, SPACE, work!.run_id, now],
    );
    await runs.markRunRunning({ run_id: work!.run_id, space_id: SPACE, started_at: new Date().toISOString() });
    await runs.markRunTerminal({
      run_id: work!.run_id,
      space_id: SPACE,
      status: "succeeded",
      output_json: canonicalRunOutput({ success: true, outputText: "workflow done", outputJson: { result: { answer: 42 } } }),
      completed_at: new Date().toISOString(),
    });
    await runs.insertRunEvaluation({ space_id: SPACE, run_id: work!.run_id, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: new Date().toISOString() });
    await Promise.all([
      service.reconcileForRun(db.pool, SPACE, work!.run_id, USER),
      service.reconcileForRun(db.pool, SPACE, work!.run_id, USER),
    ]);

    const consume = (await db.pool.query<{
      run_id: string;
      resolved_inputs_json: { values: Record<string, unknown> };
      contract_snapshot_json: { upstream_inputs_json: { values: Record<string, unknown> } };
    }>(
      `SELECT wr.run_id, wr.resolved_inputs_json, r.contract_snapshot_json
         FROM workflow_execution_node_runs wr
         JOIN workflow_execution_nodes n ON n.id = wr.node_id AND n.space_id = wr.space_id
         JOIN runs r ON r.id = wr.run_id AND r.space_id = wr.space_id
        WHERE wr.space_id = $1 AND n.execution_id = $2 AND n.node_key = 'consume'`,
      [SPACE, execution.workflowExecutionId],
    )).rows[0];
    expect(consume).toBeTruthy();
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM workflow_execution_node_runs wr
         JOIN workflow_execution_nodes n ON n.id = wr.node_id AND n.space_id = wr.space_id
        WHERE wr.space_id = $1 AND n.execution_id = $2 AND n.node_key = 'consume'`,
      [SPACE, execution.workflowExecutionId],
    )).rows[0]?.count).toBe(1);
    expect(consume!.resolved_inputs_json.values).toEqual({
      summary: "workflow done",
      answer: 42,
      report: { artifact_id: artifactId, artifact_type: "report" },
    });
    expect(consume!.contract_snapshot_json.upstream_inputs_json.values).toEqual(consume!.resolved_inputs_json.values);

    await runs.markRunRunning({ run_id: consume!.run_id, space_id: SPACE, started_at: new Date().toISOString() });
    await runs.markRunTerminal({ run_id: consume!.run_id, space_id: SPACE, status: "succeeded", output_json: { result: "consumed" }, completed_at: new Date().toISOString() });
    await runs.insertRunEvaluation({ space_id: SPACE, run_id: consume!.run_id, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: new Date().toISOString() });
    await service.reconcileForRun(db.pool, SPACE, consume!.run_id, USER);

    const checkpoint = (await db.pool.query<{ proposal_id: string }>(
      `SELECT approval_proposal_id AS proposal_id FROM workflow_execution_nodes WHERE space_id = $1 AND execution_id = $2 AND node_key = 'checkpoint'`,
      [SPACE, execution.workflowExecutionId],
    )).rows[0];
    expect(checkpoint?.proposal_id).toBeTruthy();
    const apply = PgProposalApplyService.fromConfig(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test-internal-token" }));
    const accepted = await apply.accept(checkpoint!.proposal_id, identity);
    expect(accepted?.proposal.status).toBe("accepted");
    const finalState = (await db.pool.query<{ execution_status: string; root_status: string; linked_execution_id: string }>(
      `SELECT e.status AS execution_status, root.status AS root_status, ar.workflow_execution_id AS linked_execution_id
         FROM workflow_executions e JOIN runs root ON root.id = e.root_run_id
         JOIN automation_runs ar ON ar.workflow_execution_id = e.id
        WHERE e.space_id = $1 AND e.id = $2`,
      [SPACE, execution.workflowExecutionId],
    )).rows[0];
    expect(finalState).toEqual({ execution_status: "completed", root_status: "succeeded", linked_execution_id: execution.workflowExecutionId });
  });

  it("fails closed for a missing required binding while an optional sibling continues", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO automations (
         id, space_id, owner_user_id, agent_id, name, trigger_type, status,
         config_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Binding workflow', 'manual', 'active',
                 '{"target_type":"workflow"}'::jsonb, $5, $5)`,
      [AUTOMATION, SPACE, USER, AGENT, now],
    );
    const automation = {
      id: AUTOMATION, space_id: SPACE, owner_user_id: USER, agent_id: AGENT,
      project_folder_id: null, project_id: null, name: "Binding workflow", description: null,
      trigger_type: "manual", status: "active", preflight_snapshot_json: null,
      config_json: { target_type: "workflow" }, next_run_at: null, last_fired_at: null,
      created_at: now, updated_at: now,
    };
    const service = new WorkflowExecutionService(CONFIG);
    const execution = await service.start({
      db: db.pool,
      identity,
      automation,
      target: {
        versionId: BINDING_WORKFLOW_VERSION,
        resolutionTrace: [],
        contentJson: {
          schema_version: "workflow_definition.v1",
          workflow_id: "binding-failure-workflow",
          name: "Binding failure workflow",
          description: "Checks required and optional inputs.",
          input_schema_json: {}, output_artifact_types: [], metadata_json: {},
          nodes: [
            { id: "source", title: "Source", depends_on: [], capability_id: "source", contract_json: {}, metadata_json: {} },
            { id: "required", title: "Required", depends_on: ["source"], capability_id: "required", input_bindings: [{ name: "missing", from_node: "source", source: "output_text" }], contract_json: {}, metadata_json: {} },
            { id: "optional", title: "Optional", depends_on: ["source"], capability_id: "optional", input_bindings: [{ name: "missing", from_node: "source", source: "output_text", required: false }], contract_json: {}, metadata_json: {} },
          ],
        },
      },
      triggerType: "manual", inputJson: {}, preflightSnapshot: { executable: true }, budgetSources: [],
    });
    const sourceRun = (await db.pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id = link.node_id AND node.space_id = link.space_id
       WHERE node.execution_id = $1 AND node.node_key = 'source'`,
      [execution.workflowExecutionId],
    )).rows[0]!.run_id;
    const runs = new PgRunRepository(db.pool);
    await runs.markRunRunning({ run_id: sourceRun, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({
      run_id: sourceRun,
      space_id: SPACE,
      status: "succeeded",
      // Canonical-shaped but with no summary text, to exercise the
      // "output_text_missing" sub-case distinctly from "not canonical at all".
      output_json: { schema_version: "run_output.v1", status: "succeeded", summary: null, result: {}, output_manifest: [] },
      completed_at: now,
    });
    await runs.insertRunEvaluation({ space_id: SPACE, run_id: sourceRun, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: now });
    await service.reconcileForRun(db.pool, SPACE, sourceRun, USER);

    const states = (await db.pool.query<{
      node_key: string; status: string; blocked_reason: string | null;
      run_count: number; resolved_inputs_json: { values: Record<string, unknown>; bindings: Array<{ missing_reason: string | null }> } | null;
    }>(
      `SELECT node.node_key, node.status, node.blocked_reason,
              count(link.id)::int AS run_count,
              max(link.resolved_inputs_json::text)::jsonb AS resolved_inputs_json
         FROM workflow_execution_nodes node
         LEFT JOIN workflow_execution_node_runs link ON link.node_id = node.id AND link.space_id = node.space_id
        WHERE node.execution_id = $1 AND node.node_key IN ('required', 'optional')
        GROUP BY node.id ORDER BY node.node_key`,
      [execution.workflowExecutionId],
    )).rows;
    expect(states[0]).toMatchObject({ node_key: "optional", status: "in_progress", run_count: 1 });
    expect(states[0]!.resolved_inputs_json?.values).toEqual({ missing: null });
    expect(states[0]!.resolved_inputs_json?.bindings[0]?.missing_reason).toBe("output_text_missing");
    expect(states[1]).toMatchObject({ node_key: "required", status: "failed", run_count: 0 });
    expect(states[1]!.blocked_reason).toBe("input_binding_unresolved:missing:output_text_missing");
  });

  it("dispatches 'action' nodes to a registered deterministic handler without spawning an agent run", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    actionNodeHandlerRegistry.register("test.echo_action", async (context) => ({
      output: { echoed: context.inputs.value },
    }), "plan_graph_test");
    actionNodeHandlerRegistry.register("test.failing_action", async () => {
      throw new ActionNodeHandlerError("deliberate test failure", { partial: true });
    }, "plan_graph_test");
    actionNodeHandlerRegistry.register("test.sql_failing_action", async (context) => {
      await context.db.query(`UPDATE automations SET name='must roll back' WHERE id=$1`, [AUTOMATION]);
      await context.db.query(`SELECT 1/0`);
      return { output: {} };
    }, "plan_graph_test");
    await db.pool.query(
      `INSERT INTO automations (
         id, space_id, owner_user_id, agent_id, name, trigger_type, status,
         config_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Action node automation', 'manual', 'active',
                 '{"target_type":"workflow"}'::jsonb, $5, $5)`,
      [AUTOMATION, SPACE, USER, AGENT, now],
    );
    const automation = {
      id: AUTOMATION, space_id: SPACE, owner_user_id: USER, agent_id: AGENT,
      project_folder_id: null, project_id: null, name: "Action node automation", description: null,
      trigger_type: "manual", status: "active", preflight_snapshot_json: null,
      config_json: { target_type: "workflow" }, next_run_at: null, last_fired_at: null,
      created_at: now, updated_at: now,
    };
    const service = new WorkflowExecutionService(CONFIG);
    const execution = await service.start({
      db: db.pool,
      identity,
      automation,
      target: {
        versionId: BINDING_WORKFLOW_VERSION,
        resolutionTrace: [],
        contentJson: {
          schema_version: "workflow_definition.v1",
          workflow_id: "action-node-workflow",
          name: "Action node workflow",
          description: "Exercises the action node_kind dispatch path.",
          input_schema_json: {}, output_artifact_types: [], metadata_json: {},
          nodes: [
            { id: "source", title: "Source", depends_on: [], capability_id: "source", contract_json: {}, metadata_json: {} },
            {
              id: "ok_action", title: "Echo action", depends_on: ["source"],
              input_bindings: [{ name: "value", from_node: "source", source: "output_json", json_pointer: "/value" }],
              contract_json: {}, metadata_json: { node_kind: "action", action_key: "test.echo_action" },
            },
            {
              id: "fail_action", title: "Failing action", depends_on: ["source"],
              contract_json: {}, metadata_json: { node_kind: "action", action_key: "test.failing_action" },
            },
            {
              id: "sql_fail_action", title: "SQL failing action", depends_on: ["source"],
              contract_json: {}, metadata_json: { node_kind: "action", action_key: "test.sql_failing_action" },
            },
            {
              id: "missing_action", title: "Unregistered action", depends_on: ["source"],
              contract_json: {}, metadata_json: { node_kind: "action", action_key: "test.does_not_exist" },
            },
          ],
        },
      },
      triggerType: "manual", inputJson: {}, preflightSnapshot: { executable: true }, budgetSources: [],
    });

    const sourceRun = (await db.pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id = link.node_id AND node.space_id = link.space_id
       WHERE node.execution_id = $1 AND node.node_key = 'source'`,
      [execution.workflowExecutionId],
    )).rows[0]!.run_id;
    const runs = new PgRunRepository(db.pool);
    await runs.markRunRunning({ run_id: sourceRun, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({ run_id: sourceRun, space_id: SPACE, status: "succeeded", output_json: canonicalRunOutput({ success: true, outputText: "", outputJson: { value: "world" } }), completed_at: now });
    await runs.insertRunEvaluation({ space_id: SPACE, run_id: sourceRun, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: now });
    await service.reconcileForRun(db.pool, SPACE, sourceRun, USER);

    const nodes = (await db.pool.query<{ node_key: string; status: string; blocked_reason: string | null }>(
      `SELECT node_key, status, blocked_reason FROM workflow_execution_nodes
        WHERE execution_id = $1 AND node_key IN ('ok_action', 'fail_action', 'sql_fail_action', 'missing_action')
        ORDER BY node_key`,
      [execution.workflowExecutionId],
    )).rows;
    expect(nodes).toEqual([
      { node_key: "fail_action", status: "failed", blocked_reason: "action_handler_error:deliberate test failure" },
      { node_key: "missing_action", status: "failed", blocked_reason: "action_handler_not_registered:test.does_not_exist" },
      { node_key: "ok_action", status: "done", blocked_reason: null },
      { node_key: "sql_fail_action", status: "failed", blocked_reason: "action_handler_error:division by zero" },
    ]);
    expect((await db.pool.query<{ name: string }>(`SELECT name FROM automations WHERE id=$1`, [AUTOMATION])).rows[0]?.name)
      .toBe("Action node automation");

    const okRun = (await db.pool.query<{
      run_type: string; status: string; output_json: { echoed: string };
      outcome_status: string;
    }>(
      `SELECT r.run_type, r.status, r.output_json,
              (SELECT outcome_status FROM run_evaluations re WHERE re.run_id = r.id ORDER BY re.evaluated_at DESC LIMIT 1) AS outcome_status
         FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes n ON n.id = link.node_id AND n.space_id = link.space_id
         JOIN runs r ON r.id = link.run_id AND r.space_id = link.space_id
        WHERE n.execution_id = $1 AND n.node_key = 'ok_action'`,
      [execution.workflowExecutionId],
    )).rows[0];
    expect(okRun).toEqual({
      run_type: "system",
      status: "succeeded",
      output_json: canonicalRunOutput({ success: true, outputText: "Workflow action completed.", outputJson: { echoed: "world" } }),
      outcome_status: "passed",
    });

    const failRun = (await db.pool.query<{
      status: string; output_json: { partial: boolean }; outcome_status: string;
    }>(
      `SELECT r.status, r.output_json,
              (SELECT outcome_status FROM run_evaluations re WHERE re.run_id = r.id ORDER BY re.evaluated_at DESC LIMIT 1) AS outcome_status
         FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes n ON n.id = link.node_id AND n.space_id = link.space_id
         JOIN runs r ON r.id = link.run_id AND r.space_id = link.space_id
        WHERE n.execution_id = $1 AND n.node_key = 'fail_action'`,
      [execution.workflowExecutionId],
    )).rows[0];
    expect(failRun).toEqual({
      status: "failed",
      output_json: canonicalRunOutput({ success: false, outputText: "", outputJson: { partial: true } }),
      outcome_status: "failed",
    });

    const missingRunCount = (await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes n ON n.id = link.node_id AND n.space_id = link.space_id
        WHERE n.execution_id = $1 AND n.node_key = 'missing_action'`,
      [execution.workflowExecutionId],
    )).rows[0]?.count;
    expect(missingRunCount).toBe(0);
  });

  it("keeps an async Action node in progress until its delegated Run finishes", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    let delegationCount = 0;
    actionNodeHandlerRegistry.register("test.delegate_run", async (context) => {
      delegationCount += 1;
      const delegated = await new PgRunRepository(context.db).createQueuedRunWithBudgetAdmission({
        agent_id: AGENT,
        space_id: SPACE,
        user_id: USER,
        mode: "live",
        run_type: "agent",
        trigger_origin: "system",
        prompt: `Delegated model work ${delegationCount}`,
        instruction: "Return a deterministic test value.",
      });
      return { output: { queued: true }, delegatedRunId: delegated.id };
    }, "plan_graph_test");
    actionNodeHandlerRegistry.register("test.consume_delegated", async (context) => ({
      output: {
        source_run_id: context.bindings.find((binding) => binding.name === "value")?.source_run_id,
        value: context.inputs.value,
      },
    }), "plan_graph_test");
    await db.pool.query(
      `INSERT INTO automations (
         id, space_id, owner_user_id, agent_id, name, trigger_type, status,
         config_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'Delegated action automation','manual','active',
                 '{"target_type":"workflow"}'::jsonb,$5,$5)`,
      [AUTOMATION, SPACE, USER, AGENT, now],
    );
    const automation = {
      id: AUTOMATION, space_id: SPACE, owner_user_id: USER, agent_id: AGENT,
      project_folder_id: null, project_id: null, name: "Delegated action automation", description: null,
      trigger_type: "manual", status: "active", preflight_snapshot_json: null,
      config_json: { target_type: "workflow" }, next_run_at: null, last_fired_at: null,
      created_at: now, updated_at: now,
    };
    const service = new WorkflowExecutionService(CONFIG);
    const execution = await service.start({
      db: db.pool,
      identity,
      automation,
      target: {
        versionId: BINDING_WORKFLOW_VERSION,
        resolutionTrace: [],
        contentJson: {
          schema_version: "workflow_definition.v1",
          workflow_id: "delegated-action-workflow",
          name: "Delegated Action Workflow",
          description: "Exercises async Action Run delegation.",
          input_schema_json: {}, output_artifact_types: [], metadata_json: {},
          nodes: [
            {
              id: "delegate", title: "Delegate", depends_on: [],
              contract_json: { max_attempts: 2 },
              metadata_json: { node_kind: "action", action_key: "test.delegate_run" },
            },
            {
              id: "consume", title: "Consume", depends_on: ["delegate"],
              input_bindings: [{
                name: "value", from_node: "delegate", source: "output_json",
                json_pointer: "/value", required: true,
              }],
              contract_json: {},
              metadata_json: { node_kind: "action", action_key: "test.consume_delegated" },
            },
          ],
        },
      },
      triggerType: "manual",
      inputJson: {},
      preflightSnapshot: { executable: true },
      budgetSources: [],
    });
    const firstDelegated = (await db.pool.query<{ run_id: string; status: string }>(
      `SELECT link.run_id, node.status
         FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes node
           ON node.id=link.node_id AND node.space_id=link.space_id
        WHERE node.execution_id=$1 AND node.node_key='delegate'
          AND link.role='delegated'`,
      [execution.workflowExecutionId],
    )).rows[0];
    expect(firstDelegated?.status).toBe("in_progress");

    const runs = new PgRunRepository(db.pool);
    await runs.markRunRunning({ run_id: firstDelegated!.run_id, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({
      run_id: firstDelegated!.run_id,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "test_failure" },
      completed_at: now,
    });
    await runs.insertRunEvaluation({
      space_id: SPACE,
      run_id: firstDelegated!.run_id,
      outcome_status: "failed",
      trajectory_status: "incomplete",
      evaluated_at: now,
    });
    await service.reconcileForRun(db.pool, SPACE, firstDelegated!.run_id, USER);

    const retryLinks = await db.pool.query<{ run_id: string; role: string }>(
      `SELECT link.run_id, link.role
         FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes node
           ON node.id=link.node_id AND node.space_id=link.space_id
        WHERE node.execution_id=$1 AND node.node_key='delegate'
          AND link.role LIKE 'delegated%'
        ORDER BY link.created_at ASC, link.id ASC`,
      [execution.workflowExecutionId],
    );
    expect(retryLinks.rows).toContainEqual({
      run_id: firstDelegated!.run_id,
      role: "delegated_superseded",
    });
    const delegated = retryLinks.rows.find((link) => link.role === "delegated");
    expect(delegated?.run_id).toBeTruthy();
    expect(delegated?.run_id).not.toBe(firstDelegated!.run_id);

    await runs.markRunRunning({ run_id: delegated!.run_id, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({
      run_id: delegated!.run_id,
      space_id: SPACE,
      status: "succeeded",
      output_json: canonicalRunOutput({ success: true, outputText: "", outputJson: { value: "delegated-result" } }),
      completed_at: now,
    });
    await runs.insertRunEvaluation({
      space_id: SPACE,
      run_id: delegated!.run_id,
      outcome_status: "passed",
      trajectory_status: "acceptable",
      evaluated_at: now,
    });
    await service.reconcileForRun(db.pool, SPACE, delegated!.run_id, USER);

    const consumer = (await db.pool.query<{ status: string; output_json: unknown }>(
      `SELECT node.status, run.output_json
         FROM workflow_execution_nodes node
         JOIN workflow_execution_node_runs link
           ON link.node_id=node.id AND link.space_id=node.space_id AND link.role='primary'
         JOIN runs run ON run.id=link.run_id AND run.space_id=link.space_id
        WHERE node.execution_id=$1 AND node.node_key='consume'`,
      [execution.workflowExecutionId],
    )).rows[0];
    expect(consumer).toEqual({
      status: "done",
      output_json: canonicalRunOutput({
        success: true,
        outputText: "Workflow action completed.",
        outputJson: { source_run_id: delegated!.run_id, value: "delegated-result" },
      }),
    });
  });

  it("retries a failed node up to contract_json.max_attempts before failing it, and never retries beyond the cap", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO automations (
         id, space_id, owner_user_id, agent_id, name, trigger_type, status,
         config_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Retry automation', 'manual', 'active',
                 '{"target_type":"workflow"}'::jsonb, $5, $5)`,
      [AUTOMATION, SPACE, USER, AGENT, now],
    );
    const automation = {
      id: AUTOMATION, space_id: SPACE, owner_user_id: USER, agent_id: AGENT,
      project_folder_id: null, project_id: null, name: "Retry automation", description: null,
      trigger_type: "manual", status: "active", preflight_snapshot_json: null,
      config_json: { target_type: "workflow" }, next_run_at: null, last_fired_at: null,
      created_at: now, updated_at: now,
    };
    const service = new WorkflowExecutionService(CONFIG);
    const execution = await service.start({
      db: db.pool,
      identity,
      automation,
      target: {
        versionId: BINDING_WORKFLOW_VERSION,
        resolutionTrace: [],
        contentJson: {
          schema_version: "workflow_definition.v1",
          workflow_id: "retry-workflow",
          name: "Retry workflow",
          description: "Exercises unified minimal Node Retry.",
          input_schema_json: {}, output_artifact_types: [], metadata_json: {},
          nodes: [
            { id: "flaky", title: "Flaky work", depends_on: [], capability_id: "flaky-work", contract_json: { max_attempts: 2 }, metadata_json: {} },
            { id: "always_fails", title: "Always fails", depends_on: [], capability_id: "always-fails-work", contract_json: { max_attempts: 2 }, metadata_json: {} },
          ],
        },
      },
      triggerType: "manual", inputJson: {}, preflightSnapshot: { executable: true }, budgetSources: [],
    });
    const runs = new PgRunRepository(db.pool);

    const firstFlakyRun = (await db.pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id = link.node_id AND node.space_id = link.space_id
       WHERE node.execution_id = $1 AND node.node_key = 'flaky'`,
      [execution.workflowExecutionId],
    )).rows[0]!.run_id;
    await runs.markRunRunning({ run_id: firstFlakyRun, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({ run_id: firstFlakyRun, space_id: SPACE, status: "failed", error_json: { error_code: "transient" }, completed_at: now });
    // One reconcile pass both projects the failed run's outcome onto the
    // node (attempt 1 of 2 remaining -> back to 'ready', not 'failed') and
    // immediately re-dispatches the ready node into attempt 2 — retry is not
    // a separate step the caller has to remember to trigger.
    await service.reconcileForRun(db.pool, SPACE, firstFlakyRun, USER);

    const afterFirstFailure = (await db.pool.query<{ status: string; blocked_reason: string | null }>(
      `SELECT status, blocked_reason FROM workflow_execution_nodes WHERE execution_id = $1 AND node_key = 'flaky'`,
      [execution.workflowExecutionId],
    )).rows[0];
    expect(afterFirstFailure).toMatchObject({ status: "in_progress" });
    expect(afterFirstFailure!.blocked_reason).toContain("run_failed:failed");

    const flakyRunRows = (await db.pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id = link.node_id AND node.space_id = link.space_id
       WHERE node.execution_id = $1 AND node.node_key = 'flaky' ORDER BY link.created_at ASC`,
      [execution.workflowExecutionId],
    )).rows;
    expect(flakyRunRows).toHaveLength(2);
    expect(flakyRunRows[0]!.run_id).not.toBe(flakyRunRows[1]!.run_id);
    const secondFlakyRun = flakyRunRows[1]!.run_id;
    await runs.markRunRunning({ run_id: secondFlakyRun, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({ run_id: secondFlakyRun, space_id: SPACE, status: "succeeded", output_json: {}, completed_at: now });
    await runs.insertRunEvaluation({ space_id: SPACE, run_id: secondFlakyRun, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: now });
    await service.reconcileForRun(db.pool, SPACE, secondFlakyRun, USER);
    expect((await db.pool.query<{ status: string }>(
      `SELECT status FROM workflow_execution_nodes WHERE execution_id = $1 AND node_key = 'flaky'`,
      [execution.workflowExecutionId],
    )).rows[0]).toEqual({ status: "done" });

    // The node whose every attempt fails only fails once max_attempts (2) is exhausted, never before.
    const alwaysFailsRun1 = (await db.pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id = link.node_id AND node.space_id = link.space_id
       WHERE node.execution_id = $1 AND node.node_key = 'always_fails'`,
      [execution.workflowExecutionId],
    )).rows[0]!.run_id;
    await runs.markRunRunning({ run_id: alwaysFailsRun1, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({ run_id: alwaysFailsRun1, space_id: SPACE, status: "failed", error_json: { error_code: "persistent" }, completed_at: now });
    await service.reconcileForRun(db.pool, SPACE, alwaysFailsRun1, USER);
    expect((await db.pool.query<{ status: string }>(
      `SELECT status FROM workflow_execution_nodes WHERE execution_id = $1 AND node_key = 'always_fails'`,
      [execution.workflowExecutionId],
    )).rows[0]).toEqual({ status: "in_progress" });
    const alwaysFailsRun2 = (await db.pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id = link.node_id AND node.space_id = link.space_id
       WHERE node.execution_id = $1 AND node.node_key = 'always_fails' ORDER BY link.created_at DESC LIMIT 1`,
      [execution.workflowExecutionId],
    )).rows[0]!.run_id;
    expect(alwaysFailsRun2).not.toBe(alwaysFailsRun1);
    await runs.markRunRunning({ run_id: alwaysFailsRun2, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({ run_id: alwaysFailsRun2, space_id: SPACE, status: "failed", error_json: { error_code: "persistent" }, completed_at: now });
    await service.reconcileForRun(db.pool, SPACE, alwaysFailsRun2, USER);
    const finalAlwaysFails = (await db.pool.query<{ status: string; count: number }>(
      `SELECT node.status,
              (SELECT count(*)::int FROM workflow_execution_node_runs wr WHERE wr.node_id = node.id) AS count
         FROM workflow_execution_nodes node WHERE node.execution_id = $1 AND node.node_key = 'always_fails'`,
      [execution.workflowExecutionId],
    )).rows[0];
    expect(finalAlwaysFails).toEqual({ status: "failed", count: 2 });
  });
});
