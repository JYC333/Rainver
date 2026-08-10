import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import { lockActiveProjectForMutation } from "../projects/access";
import { HttpError, withQueryableTransaction } from "../routeUtils/common";
import { PgJobQueueRepository } from "../jobs/repository";
import { PgRunRepository } from "../runs/repository";
import { canonicalRunOutput } from "../runs/orchestrationResults";
import { assertBudgetSourcesAvailable } from "../runs/budgetEnforcement";
import type { RunBudgetSource } from "../runs/contractSnapshot";
import { materializePlanGraph, type MaterializedPlanGraph } from "../plans/graph";
import type { AutomationRow } from "./repository";
import { ExecutionGraphScheduler } from "../execution/executionGraphScheduler";
import { InputBindingResolutionError, resolveNodeInputs, type ResolvedNodeInputs } from "../execution/nodeInputResolver";
import { actionNodeHandlerRegistry, ActionNodeHandlerError } from "./actionNodeRegistry";
import { workflowExecutionOutcomeHandlerRegistry } from "./workflowExecutionOutcomeRegistry";
import type { WorkflowNodeInputBinding } from "@agent-space/protocol" with { "resolution-mode": "import" };

export interface ResolvedWorkflowExecutionTarget {
  versionId: string;
  contentJson: unknown;
  resolutionTrace: string[];
}

export interface WorkflowExecutionStartInput {
  db: Queryable;
  identity: SpaceUserIdentity;
  automation: AutomationRow;
  target: ResolvedWorkflowExecutionTarget;
  triggerType: string;
  prompt?: string | null;
  instruction?: string | null;
  inputJson: Record<string, unknown>;
  preflightSnapshot: Record<string, unknown>;
  triggerContext?: Record<string, unknown> | null;
  budgetSources: RunBudgetSource[];
  researchOperationId?: string | null;
  beforeSchedule?: (executionId: string) => Promise<void>;
}

export class WorkflowExecutionService {
  private readonly scheduler = new ExecutionGraphScheduler();

  constructor(private readonly config: ServerConfig) {}

  async start(input: WorkflowExecutionStartInput): Promise<{
    workflowExecutionId: string;
    rootRunId: string;
    scheduledNodeIds: string[];
  }> {
    const graph = await materializePlanGraph(input.target.contentJson);
    if (input.automation.project_id) {
      await lockActiveProjectForMutation(input.db, input.identity.spaceId, input.automation.project_id);
    }
    await lockAutomationBudget(input.db, input.automation, input.budgetSources);
    const now = new Date().toISOString();
    const executionId = randomUUID();
    await input.db.query(
      `INSERT INTO workflow_executions (
         id, space_id, automation_id, workflow_version_id, status, trigger_type,
         input_json, definition_json, resolution_trace_json, contract_snapshot_json,
         budget_snapshot_json, research_operation_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'queued', $5, $6::jsonb, $7::jsonb, $8::jsonb,
                 $9::jsonb, $10::jsonb, $11, $12, $12)`,
      [executionId, input.identity.spaceId, input.automation.id, input.target.versionId, input.triggerType,
        JSON.stringify(input.inputJson), JSON.stringify(input.target.contentJson), JSON.stringify(input.target.resolutionTrace),
        JSON.stringify(automationContractSnapshot(input.automation)), JSON.stringify({ sources: input.budgetSources }),
        input.researchOperationId ?? null, now],
    );
    const root = await new PgRunRepository(input.db).createCoordinatorRun({
      agent_id: input.automation.agent_id,
      space_id: input.identity.spaceId,
      user_id: input.identity.userId,
      mode: "live",
      run_type: "workflow",
      trigger_origin: "automation",
      project_folder_id: input.automation.project_folder_id,
      project_id: input.automation.project_id,
      prompt: input.prompt ?? input.automation.name,
      instruction: input.instruction ?? `Execute workflow automation '${input.automation.name}'.`,
      workflow_version_id: input.target.versionId,
      contract_snapshot: {
        source: { kind: "workflow", id: input.target.versionId },
        project_id: input.automation.project_id,
        project_folder_id: input.automation.project_folder_id,
        budget_sources: input.budgetSources,
        workflow_input_json: input.inputJson,
        route_hints_json: { workflow_execution_id: executionId, automation_id: input.automation.id },
      },
    });
    await input.db.query(`UPDATE workflow_executions SET root_run_id = $3, status = 'running', started_at = $4, updated_at = $4 WHERE id = $1 AND space_id = $2`, [executionId, input.identity.spaceId, root.id, now]);
    await input.db.query(`UPDATE runs SET status = 'waiting_for_dependency', updated_at = $3 WHERE id = $2 AND space_id = $1`, [input.identity.spaceId, root.id, now]);
    await input.beforeSchedule?.(executionId);
    const nodeIds = await insertWorkflowNodes(input.db, input.identity.spaceId, executionId, graph, now);
    const scheduledNodeIds = await this.scheduleReadyNodes(input, { executionId, rootRunId: root.id, nodeIds });
    await this.finishIfSettled(
      input.db,
      input.identity.spaceId,
      executionId,
      root.id,
      input.target.contentJson,
      input.researchOperationId ?? null,
    );
    return { workflowExecutionId: executionId, rootRunId: root.id, scheduledNodeIds };
  }

  private async finishIfSettled(
    db: Queryable,
    spaceId: string,
    executionId: string,
    rootRunId: string,
    definitionJson: unknown,
    researchOperationId: string | null,
  ): Promise<void> {
    const nodes = await db.query<{ status: string }>(
      `SELECT status FROM workflow_execution_nodes
        WHERE space_id=$1 AND execution_id=$2`,
      [spaceId, executionId],
    );
    const graphNodes = nodes.rows.map((node) => ({
      id: "",
      status: node.status,
      dependsOn: [] as string[],
    }));
    if (this.scheduler.hasFailedNode(graphNodes)) {
      await finishWorkflowExecution(
        db, spaceId, executionId, rootRunId, "failed",
        "A workflow execution node failed", definitionJson, researchOperationId,
      );
    } else if (this.scheduler.isComplete(graphNodes)) {
      await finishWorkflowExecution(
        db, spaceId, executionId, rootRunId, "succeeded",
        "All workflow execution nodes completed", definitionJson, researchOperationId,
      );
    }
  }

  async reconcile(client: Queryable, spaceId: string, executionId: string, userId: string): Promise<Record<string, unknown>> {
    return withQueryableTransaction(client, (transaction) =>
      this.reconcileLocked(transaction, spaceId, executionId, userId));
  }

  private async reconcileLocked(client: Queryable, spaceId: string, executionId: string, userId: string): Promise<Record<string, unknown>> {
    const scope = await client.query<{ project_id: string | null }>(
      `SELECT a.project_id
         FROM workflow_executions e
         JOIN automations a ON a.id=e.automation_id AND a.space_id=e.space_id
        WHERE e.space_id=$1 AND e.id=$2`,
      [spaceId, executionId],
    );
    if (!scope.rows[0]) throw new HttpError(404, "Workflow Execution not found");
    if (scope.rows[0].project_id) {
      // Aggregate lock must precede the execution lock so archive and
      // reconciliation share the Project -> WorkflowExecution order.
      await lockActiveProjectForMutation(client, spaceId, scope.rows[0].project_id);
    }
    const result = await client.query<{
      id: string; automation_id: string; workflow_version_id: string; root_run_id: string | null;
      status: string; input_json: Record<string, unknown>; definition_json: unknown; resolution_trace_json: string[];
      budget_snapshot_json: unknown; project_id: string | null; project_folder_id: string | null; agent_id: string;
      research_operation_id: string | null;
      name: string; description: string | null; config_json: Record<string, unknown> | null;
      automation_status: string;
    }>(
      `SELECT e.id, e.automation_id, e.workflow_version_id, e.root_run_id, e.status,
              e.input_json, e.definition_json, e.resolution_trace_json, e.budget_snapshot_json,
              e.research_operation_id,
              a.project_id, a.project_folder_id, a.agent_id, a.name, a.description, a.config_json,
              a.status AS automation_status
         FROM workflow_executions e JOIN automations a ON a.id = e.automation_id AND a.space_id = e.space_id
        WHERE e.space_id = $1 AND e.id = $2 FOR UPDATE`,
      [spaceId, executionId],
    );
    const execution = result.rows[0];
    if (!execution) throw new HttpError(404, "Workflow Execution not found");
    if (!['queued', 'running'].includes(execution.status) || execution.automation_status !== "active") {
      return { workflow_execution_id: executionId, status: execution.status, scheduled_node_ids: [] };
    }
    await projectLatestWorkflowNodeRuns(client, spaceId, executionId);
    const nodes = await client.query<{ id: string; status: string; depends_on: string[] }>(
      `SELECT n.id, n.status,
              COALESCE(array_agg(d.depends_on_node_id) FILTER (WHERE d.depends_on_node_id IS NOT NULL), ARRAY[]::varchar[]) AS depends_on
         FROM workflow_execution_nodes n
         LEFT JOIN workflow_execution_dependencies d
           ON d.node_id = n.id AND d.space_id = n.space_id AND d.execution_id = n.execution_id
        WHERE n.space_id = $1 AND n.execution_id = $2
        GROUP BY n.id
        ORDER BY n.created_at ASC, n.id ASC`,
      [spaceId, executionId],
    );
    const graphNodes = nodes.rows.map((node) => ({ id: node.id, status: node.status, dependsOn: node.depends_on }));
    if (this.scheduler.hasFailedNode(graphNodes)) {
      await finishWorkflowExecution(
        client,
        spaceId,
        executionId,
        execution.root_run_id,
        "failed",
        "A workflow execution node failed",
        execution.definition_json,
        execution.research_operation_id,
      );
      return { workflow_execution_id: executionId, status: "failed", scheduled_node_ids: [] };
    }
    if (this.scheduler.isComplete(graphNodes)) {
      await finishWorkflowExecution(
        client,
        spaceId,
        executionId,
        execution.root_run_id,
        "succeeded",
        "All workflow execution nodes completed",
        execution.definition_json,
        execution.research_operation_id,
      );
      return { workflow_execution_id: executionId, status: "completed", scheduled_node_ids: [] };
    }
    if (!execution.root_run_id) throw new HttpError(409, "Workflow Execution coordinator run is missing");
    const automation: AutomationRow = {
      id: execution.automation_id,
      space_id: spaceId,
      owner_user_id: userId,
      agent_id: execution.agent_id,
      project_folder_id: execution.project_folder_id,
      project_id: execution.project_id,
      name: execution.name,
      description: execution.description,
      trigger_type: "manual",
      status: execution.automation_status,
      preflight_snapshot_json: null,
      config_json: execution.config_json,
      next_run_at: null,
      last_fired_at: null,
      created_at: "",
      updated_at: "",
    };
    const nodeIds = await nodeIdMap(client, spaceId, executionId);
    const scheduledNodeIds = await this.scheduleReadyNodes({
      db: client,
      identity: { spaceId, userId },
      automation,
      target: { versionId: execution.workflow_version_id, contentJson: execution.definition_json, resolutionTrace: execution.resolution_trace_json ?? [] },
      triggerType: "manual",
      inputJson: execution.input_json ?? {},
      preflightSnapshot: {},
      budgetSources: budgetSourcesFromSnapshot(execution.budget_snapshot_json),
    }, { executionId, rootRunId: execution.root_run_id, nodeIds });
    return { workflow_execution_id: executionId, status: "running", scheduled_node_ids: scheduledNodeIds };
  }

  async reconcileForRun(client: Queryable, spaceId: string, runId: string, userId: string): Promise<void> {
    const rows = await client.query<{ execution_id: string }>(
      `SELECT DISTINCT node.execution_id
         FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes node ON node.id = link.node_id AND node.space_id = link.space_id
        WHERE link.space_id = $1 AND link.run_id = $2`,
      [spaceId, runId],
    );
    for (const row of rows.rows) await this.reconcile(client, spaceId, row.execution_id, userId);
  }

  private async scheduleReadyNodes(
    input: WorkflowExecutionStartInput,
    context: { executionId: string; rootRunId: string; nodeIds: Map<string, string> },
  ): Promise<string[]> {
    const rows = await input.db.query<{
      id: string; node_key: string; node_kind: string; title: string; description: string | null;
      status: string; assigned_agent_id: string | null; runtime_profile_id: string | null;
      capability_id: string | null; contract_json: Record<string, unknown>; metadata_json: Record<string, unknown>;
      input_bindings_json: WorkflowNodeInputBinding[];
      depends_on: string[]; approval_proposal_id: string | null;
    }>(
      `SELECT n.id, n.node_key, n.node_kind, n.title, n.description, n.status,
              n.assigned_agent_id, n.runtime_profile_id, n.capability_id, n.contract_json,
              n.input_bindings_json,
              n.metadata_json, n.approval_proposal_id,
              COALESCE(array_agg(d.depends_on_node_id) FILTER (WHERE d.depends_on_node_id IS NOT NULL), ARRAY[]::varchar[]) AS depends_on
         FROM workflow_execution_nodes n
         LEFT JOIN workflow_execution_dependencies d ON d.node_id = n.id AND d.space_id = n.space_id
        WHERE n.space_id = $1 AND n.execution_id = $2 AND n.status IN ('inbox', 'ready')
        GROUP BY n.id ORDER BY n.created_at ASC, n.id ASC`,
      [input.identity.spaceId, context.executionId],
    );
    const queue = new PgJobQueueRepository(input.db);
    const scheduled: string[] = [];
    const statusResult = await input.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM workflow_execution_nodes WHERE space_id = $1 AND execution_id = $2`,
      [input.identity.spaceId, context.executionId],
    );
    const dependenciesById = new Map(rows.rows.map((node) => [node.id, node.depends_on]));
    const readyNodeIds = new Set(this.scheduler.readyNodes(statusResult.rows.map((node) => ({
      id: node.id,
      status: node.status,
      dependsOn: dependenciesById.get(node.id) ?? [],
    }))).map((node) => node.id));
    for (const node of rows.rows) {
      if (!readyNodeIds.has(node.id)) continue;
      if (node.node_kind === "approval_checkpoint") {
        if (node.approval_proposal_id) continue;
        const proposalId = randomUUID();
        const now = new Date().toISOString();
        await input.db.query(
          `INSERT INTO proposals (id, space_id, proposal_type, status, risk_level, urgency, title, summary,
             payload_json, created_at, updated_at, created_by_user_id, owner_user_id, project_id, project_folder_id)
           VALUES ($1, $2, 'workflow_execution_checkpoint', 'pending', 'medium', 'normal', $3, $4, $5::jsonb, $6, $6, $7, $7, $8, $9)`,
          [proposalId, input.identity.spaceId, `Approve workflow checkpoint: ${node.title}`, "This fixed Workflow Execution is paused at an explicit approval checkpoint.", JSON.stringify({ workflow_execution_id: context.executionId, node_id: node.id, automation_id: input.automation.id }), now, input.identity.userId, input.automation.project_id, input.automation.project_folder_id],
        );
        await input.db.query(`UPDATE workflow_execution_nodes SET status = 'waiting_for_review', approval_proposal_id = $3, blocked_reason = $4, updated_at = $5 WHERE id = $1 AND space_id = $2`, [node.id, input.identity.spaceId, proposalId, "Approval checkpoint is pending", now]);
        scheduled.push(node.id);
        continue;
      }
      if (node.node_kind === "integration") {
        await input.db.query(
          `UPDATE workflow_execution_nodes
              SET status='done', blocked_reason=NULL, updated_at=now()
            WHERE id=$1 AND space_id=$2`,
          [node.id, input.identity.spaceId],
        );
        scheduled.push(node.id);
        continue;
      }
      const childAgentId = node.assigned_agent_id ?? input.automation.agent_id;
      let resolvedInputs;
      try {
        resolvedInputs = await resolveNodeInputs(input.db, {
          spaceId: input.identity.spaceId,
          bindings: node.input_bindings_json,
          sourceTable: "workflow_execution_nodes",
          linkTable: "workflow_execution_node_runs",
          linkNodeColumn: "node_id",
          scopeColumn: "execution_id",
          scopeId: context.executionId,
        });
      } catch (error) {
        if (!(error instanceof InputBindingResolutionError)) throw error;
        const now = new Date().toISOString();
        await input.db.query(
          `UPDATE workflow_execution_nodes SET status = 'failed', blocked_reason = $3, updated_at = $4 WHERE id = $1 AND space_id = $2`,
          [node.id, input.identity.spaceId, `input_binding_unresolved:${error.bindingName}:${error.reason}`, now],
        );
        scheduled.push(node.id);
        continue;
      }
      if (node.node_kind === "action") {
        await this.runActionNode(input, context, node, childAgentId, resolvedInputs);
        scheduled.push(node.id);
        continue;
      }
      const child = await new PgRunRepository(input.db).createQueuedRun({
        agent_id: childAgentId,
        space_id: input.identity.spaceId,
        user_id: input.identity.userId,
        mode: "live",
        run_type: "workflow",
        trigger_origin: "job",
        parent_run_id: context.rootRunId,
        root_run_id: context.rootRunId,
        project_folder_id: input.automation.project_folder_id,
        project_id: input.automation.project_id,
        prompt: input.prompt ?? node.title,
        instruction: node.description ? `Workflow Node: ${node.title}\n\n${node.description}` : `Workflow Node: ${node.title}`,
        runtime_profile_id: node.runtime_profile_id,
        runtime_profile_selection_source: node.runtime_profile_id ? "explicit" : "default",
        capability_id: node.capability_id,
        workflow_version_id: input.target.versionId,
        contract_snapshot: {
          source: { kind: "workflow", id: input.target.versionId },
          project_id: input.automation.project_id,
          project_folder_id: input.automation.project_folder_id,
          ...workflowContract(node.contract_json),
          budget_sources: input.budgetSources,
          workflow_input_json: input.inputJson,
          upstream_inputs_json: resolvedInputs,
          route_hints_json: {
            ...recordValue(workflowContract(node.contract_json).route_hints_json),
            workflow_execution_id: context.executionId,
            node_id: node.id,
            node_key: node.node_key,
          },
        },
      });
      const now = new Date().toISOString();
      await input.db.query(`INSERT INTO workflow_execution_node_runs (id, space_id, node_id, run_id, role, resolved_inputs_json, created_at) VALUES ($1, $2, $3, $4, 'primary', $5::jsonb, $6)`, [randomUUID(), input.identity.spaceId, node.id, child.id, JSON.stringify(resolvedInputs), now]);
      await input.db.query(
        `UPDATE workflow_execution_nodes
            SET status='in_progress', updated_at=$3
          WHERE id=$1 AND space_id=$2`,
        [node.id, input.identity.spaceId, now],
      );
      await queue.enqueue({ job_type: "agent_run", space_id: input.identity.spaceId, user_id: input.identity.userId, agent_id: childAgentId, project_folder_id: input.automation.project_folder_id, payload: { run_id: child.id, workflow_execution_id: context.executionId, workflow_execution_node_id: node.id } });
      scheduled.push(node.id);
    }
    return scheduled;
  }

  // Deterministic-handler dispatch for `node_kind: "action"` (plan section
  // 17.1-17.2, ADR 0011): no LLM run, so completion is synchronous rather
  // than job-queued. Still creates a `runs` row and a passing
  // `run_evaluations` row so the generic `resolveNodeInputs` binding
  // mechanism (which reads exclusively from `runs.output_json` behind a
  // passed evaluation) works identically for downstream Model/Action nodes.
  private async runActionNode(
    input: WorkflowExecutionStartInput,
    context: { executionId: string; rootRunId: string; nodeIds: Map<string, string> },
    node: {
      id: string; node_key: string; title: string; description: string | null;
      capability_id: string | null; metadata_json: Record<string, unknown>; contract_json: Record<string, unknown>;
    },
    childAgentId: string,
    resolvedInputs: ResolvedNodeInputs,
  ): Promise<void> {
    const now = new Date().toISOString();
    const runRepo = new PgRunRepository(input.db);
    const actionKey = stringValue(node.metadata_json.action_key);
    const handler = actionKey ? actionNodeHandlerRegistry.get(actionKey) : null;
    if (!actionKey || !handler) {
      await input.db.query(
        `UPDATE workflow_execution_nodes SET status = 'failed', blocked_reason = $3, updated_at = $4 WHERE id = $1 AND space_id = $2`,
        [node.id, input.identity.spaceId, actionKey ? `action_handler_not_registered:${actionKey}` : "action_key_missing", now],
      );
      return;
    }
    await input.db.query(
      `UPDATE workflow_execution_nodes
          SET status='in_progress', updated_at=$3
        WHERE id=$1 AND space_id=$2`,
      [node.id, input.identity.spaceId, now],
    );
    const run = await runRepo.createRunningSystemRun({
      space_id: input.identity.spaceId,
      user_id: input.identity.userId,
      agent_id: childAgentId,
      project_folder_id: input.automation.project_folder_id,
      project_id: input.automation.project_id,
      trigger_origin: "job",
      prompt: input.prompt ?? node.title,
      instruction: node.description ? `Workflow Action: ${node.title}\n\n${node.description}` : `Workflow Action: ${node.title}`,
      capability_id: node.capability_id,
      workflow_version_id: input.target.versionId,
      contract_snapshot: {
        source: { kind: "workflow", id: input.target.versionId },
        project_id: input.automation.project_id,
        project_folder_id: input.automation.project_folder_id,
        ...workflowContract(node.contract_json),
        budget_sources: input.budgetSources,
        workflow_input_json: input.inputJson,
        upstream_inputs_json: resolvedInputs,
        route_hints_json: { workflow_execution_id: context.executionId, node_id: node.id, node_key: node.node_key, action_key: actionKey },
      },
    });
    await input.db.query(
      `INSERT INTO workflow_execution_node_runs (id, space_id, node_id, run_id, role, resolved_inputs_json, created_at) VALUES ($1, $2, $3, $4, 'primary', $5::jsonb, $6)`,
      [randomUUID(), input.identity.spaceId, node.id, run.id, JSON.stringify(resolvedInputs), now],
    );
    // Action handlers execute inside the WorkflowExecution transaction. A
    // PostgreSQL statement error aborts that transaction until rollback; the
    // failure recorder below must therefore have a savepoint to roll back to,
    // otherwise it masks the actionable error with 25P02 and records nothing.
    const transactional = typeof (input.db as Queryable & { release?: unknown }).release === "function";
    const actionSavepoint = "workflow_action_handler";
    if (transactional) await input.db.query(`SAVEPOINT ${actionSavepoint}`);
    try {
      const result = await handler({
        db: input.db,
        identity: input.identity,
        config: this.config,
        executionId: context.executionId,
        nodeId: node.id,
        nodeKey: node.node_key,
        projectId: input.automation.project_id,
        projectFolderId: input.automation.project_folder_id,
        inputs: resolvedInputs.values,
        bindings: resolvedInputs.bindings,
        metadata: node.metadata_json,
      });
      const completedAt = new Date().toISOString();
      if (result.delegatedRunId) {
        const delegated = await input.db.query<{ id: string }>(
          `SELECT id FROM runs
            WHERE id=$1 AND space_id=$2
              AND ($3::varchar IS NULL OR project_id=$3)`,
          [result.delegatedRunId, input.identity.spaceId, input.automation.project_id],
        );
        if (!delegated.rows[0]) {
          throw new ActionNodeHandlerError(
            "Action handler returned an invalid delegated Run",
          );
        }
      }
      await runRepo.markRunTerminal({
        run_id: run.id,
        space_id: input.identity.spaceId,
        status: "succeeded",
        output_json: canonicalRunOutput({
          success: true,
          outputText: "Workflow action completed.",
          outputJson: result.output,
        }),
        completed_at: completedAt,
      });
      await runRepo.insertRunEvaluation({ space_id: input.identity.spaceId, run_id: run.id, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: completedAt });
      if (result.delegatedRunId) {
        await input.db.query(
          `INSERT INTO workflow_execution_node_runs (
             id, space_id, node_id, run_id, role, resolved_inputs_json, created_at
           ) VALUES ($1,$2,$3,$4,'delegated',$5::jsonb,$6)`,
          [
            randomUUID(),
            input.identity.spaceId,
            node.id,
            result.delegatedRunId,
            JSON.stringify(resolvedInputs),
            completedAt,
          ],
        );
        await input.db.query(
          `UPDATE workflow_execution_nodes
              SET status='in_progress', blocked_reason=NULL, updated_at=$3
            WHERE id=$1 AND space_id=$2`,
          [node.id, input.identity.spaceId, completedAt],
        );
        if (transactional) await input.db.query(`RELEASE SAVEPOINT ${actionSavepoint}`);
        return;
      }
      await input.db.query(
        `UPDATE workflow_execution_nodes
            SET status='done', blocked_reason=NULL, updated_at=$3
          WHERE id=$1 AND space_id=$2`,
        [node.id, input.identity.spaceId, completedAt],
      );
      if (transactional) await input.db.query(`RELEASE SAVEPOINT ${actionSavepoint}`);
    } catch (error) {
      if (transactional) {
        await input.db.query(`ROLLBACK TO SAVEPOINT ${actionSavepoint}`);
        await input.db.query(`RELEASE SAVEPOINT ${actionSavepoint}`);
      }
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const outputJson = error instanceof ActionNodeHandlerError ? error.outputJson : {};
      await runRepo.markRunTerminal({
        run_id: run.id,
        space_id: input.identity.spaceId,
        status: "failed",
        output_json: canonicalRunOutput({
          success: false,
          outputText: "",
          outputJson,
        }),
        error_json: { error_code: "action_node_failed", error_text: message },
        completed_at: failedAt,
      });
      await runRepo.insertRunEvaluation({ space_id: input.identity.spaceId, run_id: run.id, outcome_status: "failed", trajectory_status: "incomplete", evaluated_at: failedAt, notes: message });
      const attempts = await nodeAttemptCount(input.db, input.identity.spaceId, node.id);
      const nextStatus = attempts < nodeMaxAttempts(node.contract_json) ? "ready" : "failed";
      await input.db.query(`UPDATE workflow_execution_nodes SET status = $3, blocked_reason = $4, updated_at = $5 WHERE id = $1 AND space_id = $2`, [node.id, input.identity.spaceId, nextStatus, `action_handler_error:${message}`, failedAt]);
    }
  }
}

// Unified minimal Node Retry: the same node gets a new Run Attempt (a new
// `runs`/`workflow_execution_node_runs` row) up to `contract_json.max_attempts`
// (default 1, i.e. today's no-retry behavior); only once attempts are
// exhausted does the node — and, transitively, the execution — actually
// fail. No backoff and no arbitrary cycles: a retry is just "go back to
// 'ready' so the next scheduling pass spawns attempt N+1," bounded by a
// fixed count. rescan/resume/input-change are NOT retries — they are a new
// generation/WorkflowExecution (see project_operations.generation).
function nodeMaxAttempts(contractJson: Record<string, unknown>): number {
  const value = contractJson.max_attempts;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

async function nodeAttemptCount(db: Queryable, spaceId: string, nodeId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM workflow_execution_node_runs
      WHERE space_id=$1 AND node_id=$2 AND role='primary'`,
    [spaceId, nodeId],
  );
  return result.rows[0]?.count ?? 0;
}

async function projectLatestWorkflowNodeRuns(client: Queryable, spaceId: string, executionId: string): Promise<void> {
  const rows = await client.query<{
    node_id: string; run_id: string; link_role: string;
    run_status: string; outcome_status: string | null;
    attempt_count: number; contract_json: Record<string, unknown>;
  }>(
    `SELECT n.id AS node_id, link.run_id, link.role AS link_role,
            r.status AS run_status, evaluation.outcome_status,
            (SELECT count(*)::int FROM workflow_execution_node_runs wr2
              WHERE wr2.node_id = n.id AND wr2.space_id = n.space_id
                AND wr2.role='primary') AS attempt_count,
            n.contract_json
       FROM workflow_execution_nodes n
       JOIN LATERAL (
         SELECT wr.node_id, wr.run_id, wr.role FROM workflow_execution_node_runs wr
          WHERE wr.node_id = n.id AND wr.space_id = n.space_id
          ORDER BY (wr.role='delegated') DESC, wr.created_at DESC, wr.id DESC LIMIT 1
       ) link ON true
       JOIN runs r ON r.id = link.run_id AND r.space_id = n.space_id
       LEFT JOIN LATERAL (
         SELECT re.outcome_status FROM run_evaluations re
          WHERE re.run_id = r.id AND re.space_id = r.space_id
          ORDER BY re.evaluated_at DESC, re.id DESC LIMIT 1
       ) evaluation ON true
      WHERE n.space_id = $1 AND n.execution_id = $2
        AND (r.status IN ('failed', 'cancelled', 'orphaned') OR evaluation.outcome_status IS NOT NULL)`,
    [spaceId, executionId],
  );
  const now = new Date().toISOString();
  for (const row of rows.rows) {
    const succeeded = ["succeeded", "degraded"].includes(row.run_status) && row.outcome_status === "passed";
    if (succeeded) {
      await client.query(
        `UPDATE workflow_execution_nodes
            SET status='done', blocked_reason=NULL, updated_at=$2
          WHERE id=$1`,
        [row.node_id, now],
      );
      continue;
    }
    const failed = ["failed", "cancelled", "orphaned"].includes(row.run_status)
      || (["succeeded", "degraded"].includes(row.run_status) && row.outcome_status !== null);
    if (!failed) continue;
    const nextStatus = row.attempt_count < nodeMaxAttempts(row.contract_json) ? "ready" : "failed";
    if (nextStatus === "ready" && row.link_role === "delegated") {
      // Preserve the failed delegated Run for audit, but remove it from
      // authoritative-output selection before the next primary attempt.
      await client.query(
        `UPDATE workflow_execution_node_runs
            SET role='delegated_superseded'
          WHERE space_id=$1 AND node_id=$2 AND run_id=$3 AND role='delegated'`,
        [spaceId, row.node_id, row.run_id],
      );
    }
    await client.query(
      `UPDATE workflow_execution_nodes SET status=$2, blocked_reason=$3, updated_at=$4 WHERE id=$1`,
      [row.node_id, nextStatus, `run_failed:${row.run_status}${row.outcome_status ? `:${row.outcome_status}` : ""}`, now],
    );
  }
}

async function nodeIdMap(client: Queryable, spaceId: string, executionId: string): Promise<Map<string, string>> {
  const rows = await client.query<{ node_key: string; id: string }>(`SELECT node_key, id FROM workflow_execution_nodes WHERE space_id = $1 AND execution_id = $2`, [spaceId, executionId]);
  return new Map(rows.rows.map((row) => [row.node_key, row.id]));
}

async function finishWorkflowExecution(
  client: Queryable,
  spaceId: string,
  executionId: string,
  rootRunId: string | null,
  status: "succeeded" | "failed",
  summary: string,
  definitionJson: unknown,
  researchOperationId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const executionStatus = status === "succeeded" ? "completed" : "failed";
  await client.query(
    `UPDATE workflow_executions SET status = $3, ended_at = $4, updated_at = $4
      WHERE space_id = $1 AND id = $2`,
    [spaceId, executionId, executionStatus, now],
  );
  if (rootRunId) {
    await new PgRunRepository(client).markRunTerminal({
      run_id: rootRunId,
      space_id: spaceId,
      status,
      output_text: summary,
      output_json: canonicalRunOutput({
        success: status === "succeeded",
        outputText: summary,
        outputJson: { workflow_execution_id: executionId, coordinator: true, summary },
      }),
      error_json: status === "failed"
        ? { error_code: "workflow_node_failed", error_text: summary }
        : {},
      exit_code: status === "failed" ? 1 : 0,
      completed_at: now,
    });
  }
  const workflowId = stringValue(recordValue(definitionJson).workflow_id);
  const handler = workflowId
    ? workflowExecutionOutcomeHandlerRegistry.get(workflowId)
    : null;
  if (workflowId && handler) {
    await handler({
      db: client,
      spaceId,
      executionId,
      workflowId,
      status: executionStatus,
      researchOperationId,
    });
  }
}

function budgetSourcesFromSnapshot(value: unknown): RunBudgetSource[] {
  const sources = recordValue(value).sources;
  return Array.isArray(sources) ? sources as RunBudgetSource[] : [];
}

async function insertWorkflowNodes(client: Queryable, spaceId: string, executionId: string, graph: MaterializedPlanGraph, now: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const node of graph.nodes) {
    const id = randomUUID();
    ids.set(node.key, id);
    await client.query(
      `INSERT INTO workflow_execution_nodes (
         id, space_id, execution_id, node_key, node_kind, title, description, status,
         assigned_agent_id, runtime_profile_id, capability_id, prompt_asset_key, risk_level,
         contract_json, input_bindings_json, metadata_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'inbox', $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, $16)`,
      [id, spaceId, executionId, node.key, node.kind, node.title, node.description, node.agentId, node.runtimeProfileId, node.capabilityId, node.promptAssetKey, stringValue(node.contractJson.risk_level) ?? "low", JSON.stringify({ ...node.contractJson, verification_recipe_refs: node.verificationRecipeRefs }), JSON.stringify(node.inputBindings), JSON.stringify(node.metadataJson), now],
    );
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      const nodeId = ids.get(node.key);
      const dependencyId = ids.get(dependency);
      if (!nodeId || !dependencyId) throw new HttpError(500, "Workflow dependency materialization failed");
      await client.query(`INSERT INTO workflow_execution_dependencies (id, space_id, execution_id, node_id, depends_on_node_id, dependency_type, created_at) VALUES ($1, $2, $3, $4, $5, 'requires', $6)`, [randomUUID(), spaceId, executionId, nodeId, dependencyId, now]);
    }
  }
  return ids;
}

async function lockAutomationBudget(client: Queryable, automation: AutomationRow, sources: RunBudgetSource[]): Promise<void> {
  await client.query(`SELECT id FROM automations WHERE id = $1 AND space_id = $2 FOR UPDATE`, [automation.id, automation.space_id]);
  await assertBudgetSourcesAvailable(client, automation.space_id, sources);
}

function workflowContract(value: Record<string, unknown>): Record<string, unknown> {
  return {
    acceptance_criteria_json: value.acceptance_criteria_json ?? null,
    definition_of_done: typeof value.definition_of_done === "string" ? value.definition_of_done : null,
    required_outputs_json: value.required_outputs_json ?? null,
    structured_output_json: value.structured_output_json ?? null,
    policy_context_json: value.policy_context_json ?? null,
    risk_level: stringValue(value.risk_level),
    max_runs: positiveIntegerOrNull(value.max_runs),
    max_attempts: positiveIntegerOrNull(value.max_attempts),
    max_cost: nonNegativeNumberOrNull(value.max_cost),
    max_duration_seconds: positiveIntegerOrNull(value.max_duration_seconds),
  };
}

function automationContractSnapshot(auto: AutomationRow): Record<string, unknown> {
  const config = recordValue(auto.config_json);
  return { source: { kind: "automation", id: auto.id }, project_id: auto.project_id, project_folder_id: auto.project_folder_id, contract_json: recordValue(config.contract_json ?? config.contract) };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
