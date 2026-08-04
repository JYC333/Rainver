import { randomUUID } from "node:crypto";
import {
  HttpError,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { PgJobQueueRepository } from "../jobs/repository";
import { PgRunRepository } from "../runs/repository";
import { canonicalRunOutput } from "../runs/orchestrationResults";
import { assertBudgetSourceReferences, assertBudgetSourcesAvailable } from "../runs/budgetEnforcement";
import { resolveBudgetSources, type RunBudgetSource } from "../runs/contractSnapshot";
import { loadCanonicalPlanBudgetAuthority, type CanonicalBudgetAuthority } from "../runs/budgetAuthority";
import { budgetSourcesFromNode, decidePlanApproval, materializePlanGraph, planNodeContentHash, type MaterializedPlanGraph } from "./graph";
import { verifyIntegrationNode, verifyPlanIntegration } from "./integrationVerification";
import { ExecutionGraphScheduler } from "../execution/executionGraphScheduler";
import { InputBindingResolutionError, resolveNodeInputs } from "../execution/nodeInputResolver";
import type { WorkflowNodeInputBinding } from "@agent-space/protocol" with { "resolution-mode": "import" };

export interface AgentPlanProposalInput {
  sourceTaskId: string;
  planId?: string | null;
  planningRunId: string;
  planningToolCallId: string;
  agentId: string;
  definitionJson: unknown;
  referenceWorkflowVersionId?: string | null;
  budgetCap?: number | null;
  budgetSources?: RunBudgetSource[];
  plannerMetadata?: Record<string, unknown> | null;
}

export interface PlanExecuteInput {
  agentId?: string | null;
  prompt?: string | null;
  instruction?: string | null;
  runtimeProfileId?: string | null;
  workflowInputJson?: Record<string, unknown> | null;
}

interface PlanRow {
  id: string;
  space_id: string;
  project_folder_id: string | null;
  project_id: string | null;
  source_task_id: string;
  root_run_id: string | null;
  current_plan_version_id: string | null;
  name: string;
  description: string | null;
  status: string;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanVersionRow {
  id: string;
  plan_id: string;
  version: number;
  reference_workflow_version_id: string | null;
  planner_mode: string;
  status: string;
  approval_proposal_id: string | null;
  planning_run_id: string | null;
  planning_tool_call_id: string | null;
  node_count: number;
  depth: number;
  budget_json: unknown;
  definition_json: unknown;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanNodeRow {
  id: string;
  space_id: string;
  plan_version_id: string;
  node_key: string;
  node_kind: string;
  title: string;
  description: string | null;
  status: string;
  assigned_agent_id: string | null;
  runtime_profile_id: string | null;
  capability_id: string | null;
  prompt_asset_key: string | null;
  risk_level: string;
  acceptance_criteria_json: unknown;
  definition_of_done: string | null;
  required_outputs_json: unknown;
  input_bindings_json: WorkflowNodeInputBinding[];
  max_runs: number | null;
  max_cost: number | null;
  max_duration_seconds: number | null;
  policy_json: unknown;
  verification_recipe_refs_json: unknown;
  budget_sources_json: RunBudgetSource[];
  metadata_json: unknown;
  blocked_reason: string | null;
  content_hash: string;
  approval_proposal_id: string | null;
  created_at: string;
  updated_at: string;
}

export class PgPlanRepository {
  constructor(private readonly db: Queryable) {}

  private readonly scheduler = new ExecutionGraphScheduler();

  async listPlans(identity: SpaceUserIdentity, limit = 50, offset = 0): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<PlanRow & {
      version_id: string | null;
      version_number: number | null;
      version_status: string | null;
      node_count: number | null;
      depth: number | null;
      pending_node_count: string;
    }>(
      `SELECT p.id, p.space_id, p.project_folder_id, p.project_id, p.source_task_id,
              p.root_run_id, p.current_plan_version_id, p.name, p.description, p.status,
              p.created_by_user_id, p.created_by_agent_id, p.created_at, p.updated_at,
              v.id AS version_id, v.version AS version_number, v.status AS version_status,
              v.node_count, v.depth,
              count(n.id) FILTER (WHERE n.status IN ('blocked', 'in_progress', 'waiting_for_dependency'))::text AS pending_node_count
         FROM plans p
         LEFT JOIN plan_versions v ON v.id = p.current_plan_version_id AND v.space_id = p.space_id
         LEFT JOIN plan_nodes n ON n.plan_version_id = v.id AND n.space_id = p.space_id
        WHERE p.space_id = $1
        GROUP BY p.id, v.id
        ORDER BY p.updated_at DESC, p.id ASC
        LIMIT $2 OFFSET $3`,
      [identity.spaceId, limit, offset],
    );
    return result.rows.map((row) => ({
      id: row.id,
      space_id: row.space_id,
      project_folder_id: row.project_folder_id,
      project_id: row.project_id,
      source_task_id: row.source_task_id,
      root_run_id: row.root_run_id,
      name: row.name,
      description: row.description,
      status: row.status,
      created_by_user_id: row.created_by_user_id,
      created_by_agent_id: row.created_by_agent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      current_version: row.version_id
        ? {
            id: row.version_id,
            version: row.version_number,
            status: row.version_status,
            node_count: row.node_count,
            depth: row.depth,
            pending_node_count: Number(row.pending_node_count ?? 0),
          }
        : null,
    }));
  }

  async getPlan(identity: SpaceUserIdentity, planId: string, db: Queryable = this.db): Promise<Record<string, unknown> | null> {
    const planResult = await db.query<PlanRow>(
      `SELECT id, space_id, project_folder_id, project_id, source_task_id, root_run_id,
              current_plan_version_id, name, description, status, created_by_user_id,
              created_by_agent_id, created_at, updated_at
         FROM plans WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, planId],
    );
    const plan = planResult.rows[0];
    if (!plan) return null;
    const version = plan.current_plan_version_id
      ? await db.query<PlanVersionRow>(
          `SELECT id, plan_id, version, reference_workflow_version_id, planner_mode,
                  status, approval_proposal_id, planning_run_id, planning_tool_call_id,
                  node_count, depth, budget_json, definition_json, created_by_agent_id,
                  created_at, updated_at
             FROM plan_versions WHERE space_id = $1 AND id = $2`,
          [identity.spaceId, plan.current_plan_version_id],
        )
      : { rows: [] as PlanVersionRow[] };
    const versionRow = version.rows[0] ?? null;
    const nodes = versionRow
      ? await db.query<PlanNodeRow & { run_id: string | null; run_status: string | null; outcome_status: string | null }>(
          `SELECT n.id, n.space_id, n.plan_version_id, n.node_key, n.node_kind, n.title,
                  n.description, n.status, n.assigned_agent_id, n.runtime_profile_id,
                  n.capability_id, n.prompt_asset_key, n.risk_level,
                  n.acceptance_criteria_json, n.definition_of_done, n.required_outputs_json,
                  n.input_bindings_json,
                  n.max_runs, n.max_cost, n.max_duration_seconds, n.policy_json,
                  n.verification_recipe_refs_json, n.budget_sources_json, n.metadata_json, n.blocked_reason,
                  n.content_hash, n.approval_proposal_id, n.created_at, n.updated_at,
                  latest.run_id, latest.run_status, latest.outcome_status
             FROM plan_nodes n
             LEFT JOIN LATERAL (
               SELECT pnr.run_id, r.status AS run_status, evaluation.outcome_status
                 FROM plan_node_runs pnr
                 JOIN runs r ON r.id = pnr.run_id AND r.space_id = pnr.space_id
                 LEFT JOIN LATERAL (
                   SELECT re.outcome_status
                     FROM run_evaluations re
                    WHERE re.run_id = r.id AND re.space_id = r.space_id
                    ORDER BY re.evaluated_at DESC, re.id DESC LIMIT 1
                 ) evaluation ON true
                WHERE pnr.plan_node_id = n.id AND pnr.space_id = n.space_id
                ORDER BY pnr.created_at DESC, pnr.id DESC LIMIT 1
             ) latest ON true
            WHERE n.space_id = $1 AND n.plan_version_id = $2
            ORDER BY n.created_at ASC, n.id ASC`,
          [identity.spaceId, versionRow.id],
        )
      : { rows: [] as Array<PlanNodeRow & { run_id: string | null; run_status: string | null; outcome_status: string | null }> };
    return {
      id: plan.id,
      space_id: plan.space_id,
      project_folder_id: plan.project_folder_id,
      project_id: plan.project_id,
      source_task_id: plan.source_task_id,
      root_run_id: plan.root_run_id,
      name: plan.name,
      description: plan.description,
      status: plan.status,
      created_by_user_id: plan.created_by_user_id,
      created_by_agent_id: plan.created_by_agent_id,
      created_at: plan.created_at,
      updated_at: plan.updated_at,
      current_version: versionRow
        ? {
            id: versionRow.id,
            version: versionRow.version,
            reference_workflow_version_id: versionRow.reference_workflow_version_id,
            planner_mode: versionRow.planner_mode,
            status: versionRow.status,
            approval_proposal_id: versionRow.approval_proposal_id,
            planning_run_id: versionRow.planning_run_id,
            planning_tool_call_id: versionRow.planning_tool_call_id,
            node_count: versionRow.node_count,
            depth: versionRow.depth,
            budget_json: versionRow.budget_json,
            definition_json: versionRow.definition_json,
            created_by_agent_id: versionRow.created_by_agent_id,
            nodes: nodes.rows.map((node) => ({
              ...node,
              verification_recipe_refs_json: node.verification_recipe_refs_json,
              latest_run: node.run_id ? { run_id: node.run_id, status: node.run_status, outcome_status: node.outcome_status } : null,
            })),
            created_at: versionRow.created_at,
            updated_at: versionRow.updated_at,
          }
        : null,
    };
  }

  async getPlanForTask(identity: SpaceUserIdentity, taskId: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query<{ id: string }>(`SELECT id FROM plans WHERE space_id = $1 AND source_task_id = $2`, [identity.spaceId, taskId]);
    const id = result.rows[0]?.id;
    return id ? this.getPlan(identity, id) : null;
  }

  async createPlanFromAgent(identity: SpaceUserIdentity, input: AgentPlanProposalInput): Promise<Record<string, unknown>> {
    const graph = await materializePlanGraph(input.definitionJson);
    const declaredPlanCap = input.budgetCap ?? declaredBudgetCap(graph.definition.metadata_json);
    return withQueryableTransaction(this.db, async (client) => {
      await this.assertPlanningRun(client, identity, input);
      const taskResult = await client.query<{ id: string; task_role: string; title: string; description: string | null; project_folder_id: string | null; project_id: string | null }>(
        `SELECT id, task_role, title, description, project_folder_id, project_id
           FROM tasks WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL FOR SHARE`,
        [input.sourceTaskId, identity.spaceId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new HttpError(404, "Source task not found");
      if (task.task_role !== "source") throw new HttpError(409, "Only source tasks can own a Plan");

      const idempotent = await client.query<{ plan_id: string }>(
        `SELECT plan_id FROM plan_versions
          WHERE space_id = $1 AND planning_run_id = $2 AND planning_tool_call_id = $3`,
        [identity.spaceId, input.planningRunId, input.planningToolCallId],
      );
      if (idempotent.rows[0]) return (await this.getPlan(identity, idempotent.rows[0].plan_id, client))!;

      const existing = await client.query<PlanRow>(
        `SELECT id, space_id, project_folder_id, project_id, source_task_id, root_run_id,
                current_plan_version_id, name, description, status, created_by_user_id,
                created_by_agent_id, created_at, updated_at
           FROM plans WHERE space_id = $1 AND source_task_id = $2 FOR UPDATE`,
        [identity.spaceId, input.sourceTaskId],
      );
      if (input.planId && (!existing.rows[0] || existing.rows[0].id !== input.planId)) {
        throw new HttpError(409, "plan_id does not belong to the source task");
      }
      const planId = existing.rows[0]?.id ?? randomUUID();
      const inheritedAuthority = await loadCanonicalPlanBudgetAuthority(client, {
        spaceId: identity.spaceId,
        sourceTaskId: input.sourceTaskId,
        planningRunId: input.planningRunId,
        referenceWorkflowVersionId: input.referenceWorkflowVersionId,
      });
      const planSource: RunBudgetSource | null = declaredPlanCap === null
        ? null
        : { source: { kind: "plan", id: planId }, max_cost: declaredPlanCap };
      const budgetSources = planSource
        ? [...inheritedAuthority.sources, planSource]
        : inheritedAuthority.sources;
      const resolvedAuthority = {
        ...inheritedAuthority,
        ...resolveBudgetSources(budgetSources),
        ownership: planSource
          ? [...inheritedAuthority.ownership, { source: planSource.source, authority: "plan_declaration" as const }]
          : inheritedAuthority.ownership,
      };
      const budgetCap = resolvedAuthority.effective.max_cost;
      const approval = decidePlanApproval(graph, { budgetCap, budgetSources });
      // Node declarations remain model-authored execution contracts. They may
      // narrow a Plan, but every durable reference still has to exist.
      await assertBudgetSourceReferences(client, identity.spaceId, [
        ...budgetSources.filter((source) =>
          source.source.kind !== "plan" || source.source.id !== planId
        ),
        ...graph.nodes.flatMap(budgetSourcesFromNode),
      ]);
      const current = existing.rows[0];
      if (current?.root_run_id) {
        const root = await client.query<{ status: string }>(`SELECT status FROM runs WHERE space_id = $1 AND id = $2 FOR SHARE`, [identity.spaceId, current.root_run_id]);
        if (["queued", "running", "cancelling", "waiting_for_review", "waiting_for_dependency"].includes(root.rows[0]?.status ?? "")) {
          throw new HttpError(409, "Cannot revise a Plan while its execution is active");
        }
      }
      const versionResult = await client.query<{ next_version: string }>(
        `SELECT (COALESCE(MAX(version), 0) + 1)::text AS next_version FROM plan_versions WHERE space_id = $1 AND plan_id = $2`,
        [identity.spaceId, planId],
      );
      const versionId = randomUUID();
      const now = new Date().toISOString();
      const versionStatus = approval.mode === "auto_approved" ? "approved" : "pending_review";
      if (!current) {
        await client.query(
          `INSERT INTO plans (
             id, space_id, project_folder_id, project_id, source_task_id, current_plan_version_id,
             name, description, status, created_by_user_id, created_by_agent_id,
             metadata_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $13)`,
          [planId, identity.spaceId, task.project_folder_id, task.project_id, input.sourceTaskId, versionId,
            graph.definition.name || task.title, graph.definition.description || task.description,
            versionStatus === "approved" ? "active" : "pending_review", identity.userId, input.agentId,
            JSON.stringify(input.plannerMetadata ?? {}), now],
        );
      } else {
        await client.query(
          `UPDATE plans SET current_plan_version_id = $3, root_run_id = NULL, status = $4, created_by_agent_id = $5,
                  updated_at = $6 WHERE space_id = $1 AND id = $2`,
          [identity.spaceId, planId, versionId, versionStatus === "approved" ? "active" : "pending_review", input.agentId, now],
        );
      }
      await insertPlanVersion(client, {
        id: versionId,
        planId,
        spaceId: identity.spaceId,
        version: Number(versionResult.rows[0]?.next_version ?? 1),
        referenceWorkflowVersionId: input.referenceWorkflowVersionId ?? null,
        planningRunId: input.planningRunId,
        planningToolCallId: input.planningToolCallId,
        plannerMode: "agent",
        status: versionStatus,
        graph,
        budgetCap,
        budgetSources,
        budgetAuthority: resolvedAuthority,
        plannerMetadata: input.plannerMetadata ?? null,
        agentId: input.agentId,
        now,
      });
      await insertPlanNodes(client, identity.spaceId, versionId, graph, versionStatus, now);
      if (current?.current_plan_version_id) {
        await client.query(
          `UPDATE plan_versions SET status = 'superseded', updated_at = $3
             WHERE space_id = $1 AND plan_id = $2 AND id <> $4 AND status IN ('approved', 'active', 'pending_review')`,
          [identity.spaceId, planId, now, versionId],
        );
      }
      let proposalId: string | null = null;
      if (approval.mode === "proposal_required") {
        proposalId = randomUUID();
        await client.query(
          `INSERT INTO proposals (
             id, space_id, proposal_type, status, risk_level, urgency, title, summary,
             payload_json, created_at, updated_at, created_by_user_id, owner_user_id,
             project_id, project_folder_id, created_by_run_id
           ) VALUES ($1, $2, 'plan_review', 'pending', $3, 'normal', $4, $5, $6::jsonb,
                    $7, $7, $8, $8, $9, $10, $11)`,
          [proposalId, identity.spaceId, highestRisk(graph), `Review Agent plan: ${graph.definition.name}`,
            "Agent-generated Plan requires review before execution.", JSON.stringify({ plan_id: planId, plan_version_id: versionId, source_task_id: input.sourceTaskId, reasons: approval.reasons }), now, identity.userId, task.project_id, task.project_folder_id, input.planningRunId],
        );
        await client.query(`UPDATE plan_versions SET approval_proposal_id = $3, updated_at = $4 WHERE id = $2 AND space_id = $1`, [identity.spaceId, versionId, proposalId, now]);
        await client.query(`UPDATE plan_nodes SET status = 'blocked', blocked_reason = 'Plan version requires approval', approval_proposal_id = $3, updated_at = $4 WHERE space_id = $1 AND plan_version_id = $2`, [identity.spaceId, versionId, proposalId, now]);
      }
      return (await this.getPlan(identity, planId, client))!;
    });
  }

  async executePlan(identity: SpaceUserIdentity, planId: string, input: PlanExecuteInput) {
    return withQueryableTransaction(this.db, async (client) => {
      const result = await client.query<PlanRow & { version_id: string; version_status: string; version_budget_json: unknown; root_agent_id: string | null }>(
        `SELECT p.id, p.space_id, p.project_folder_id, p.project_id, p.source_task_id, p.root_run_id,
                p.current_plan_version_id, p.name, p.description, p.status,
                p.created_by_user_id, p.created_by_agent_id, p.created_at, p.updated_at,
                v.id AS version_id, v.status AS version_status, v.budget_json AS version_budget_json,
                p.created_by_agent_id AS root_agent_id
           FROM plans p JOIN plan_versions v ON v.id = p.current_plan_version_id AND v.space_id = p.space_id
          WHERE p.space_id = $1 AND p.id = $2 FOR UPDATE OF p`,
        [identity.spaceId, planId],
      );
      const plan = result.rows[0];
      if (!plan) throw new HttpError(404, "Plan not found");
      if (plan.version_status !== "approved") throw new HttpError(409, "Plan version must be approved before execution");
      const agentId = input.agentId ?? plan.root_agent_id;
      if (!agentId) throw new HttpError(422, "agent_id is required to execute a Plan");
      if (plan.root_run_id) {
        const root = await client.query<{ id: string; status: string }>(`SELECT id, status FROM runs WHERE space_id = $1 AND id = $2`, [identity.spaceId, plan.root_run_id]);
        if (!root.rows[0]) throw new HttpError(409, "Plan coordinator run is missing");
        return { plan_id: planId, root_run_id: plan.root_run_id, scheduled_node_ids: [], idempotent: true, root_status: root.rows[0].status };
      }
      await assertBudgetSourcesAvailable(client, identity.spaceId, budgetSourcesFromPlan(plan.version_budget_json));
      const root = await new PgRunRepository(client).createCoordinatorRun({
        agent_id: agentId,
        space_id: identity.spaceId,
        user_id: identity.userId,
        mode: "live",
        run_type: "workflow",
        trigger_origin: "manual",
        project_folder_id: plan.project_folder_id,
        project_id: plan.project_id,
        prompt: input.prompt ?? plan.name,
        instruction: input.instruction ?? `Execute Agent plan '${plan.name}'.`,
        runtime_profile_id: input.runtimeProfileId ?? null,
        contract_snapshot: {
          source: { kind: "plan", id: plan.id },
          project_id: plan.project_id,
          project_folder_id: plan.project_folder_id,
          budget_sources: budgetSourcesFromPlan(plan.version_budget_json),
          workflow_input_json: input.workflowInputJson ?? null,
        },
      });
      const now = new Date().toISOString();
      await client.query(`UPDATE plans SET root_run_id = $3, status = 'active', updated_at = $4 WHERE space_id = $1 AND id = $2`, [identity.spaceId, planId, root.id, now]);
      await client.query(`UPDATE runs SET status = 'waiting_for_dependency', updated_at = $3 WHERE space_id = $1 AND id = $2`, [identity.spaceId, root.id, now]);
      const scheduled = await this.scheduleReadyNodes(client, identity, {
        planId,
        planVersionId: plan.version_id,
        rootRunId: root.id,
        projectFolderId: plan.project_folder_id,
        projectId: plan.project_id,
        agentId,
        runtimeProfileId: input.runtimeProfileId ?? null,
        runtimeProfileSelectionSource: input.runtimeProfileId ? "explicit" : "default",
        budgetSources: budgetSourcesFromPlan(plan.version_budget_json),
        userPrompt: input.prompt ?? null,
        workflowInputJson: input.workflowInputJson ?? null,
      });
      return { plan_id: planId, root_run_id: root.id, scheduled_node_ids: scheduled };
    });
  }

  async reconcilePlan(identity: SpaceUserIdentity, planId: string) {
    return withQueryableTransaction(this.db, async (client) => {
      const result = await client.query<PlanRow & { version_id: string; version_status: string; version_budget_json: unknown; root_agent_id: string | null; root_prompt: string | null; root_runtime_profile_id: string | null }>(
        `SELECT p.id, p.space_id, p.project_folder_id, p.project_id, p.source_task_id, p.root_run_id,
                p.current_plan_version_id, p.name, p.description, p.status,
                p.created_by_user_id, p.created_by_agent_id, p.created_at, p.updated_at,
                v.id AS version_id, v.status AS version_status, v.budget_json AS version_budget_json,
                p.created_by_agent_id AS root_agent_id, root.prompt AS root_prompt,
                root.requested_runtime_profile_id AS root_runtime_profile_id
           FROM plans p JOIN plan_versions v ON v.id = p.current_plan_version_id AND v.space_id = p.space_id
           LEFT JOIN runs root ON root.id = p.root_run_id AND root.space_id = p.space_id
          WHERE p.space_id = $1 AND p.id = $2 FOR UPDATE OF p, v`,
        [identity.spaceId, planId],
      );
      const plan = result.rows[0];
      if (!plan) throw new HttpError(404, "Plan not found");
      if (!plan.root_run_id) throw new HttpError(409, "Plan has not been executed");
      if (plan.version_status !== "approved") throw new HttpError(409, "Plan version must be approved before reconciliation");
      await this.projectLatestNodeRuns(client, identity.spaceId, plan.version_id);
      const nodes = await client.query<{ id: string; node_kind: string; status: string; depends_on: string[] }>(
        `SELECT n.id, n.node_kind, n.status,
                COALESCE(array_agg(d.depends_on_node_id) FILTER (WHERE d.depends_on_node_id IS NOT NULL), ARRAY[]::varchar[]) AS depends_on
           FROM plan_nodes n LEFT JOIN plan_node_dependencies d ON d.node_id = n.id AND d.space_id = n.space_id
          WHERE n.space_id = $1 AND n.plan_version_id = $2 GROUP BY n.id ORDER BY n.created_at ASC, n.id ASC`,
        [identity.spaceId, plan.version_id],
      );
      if (this.scheduler.hasFailedNode(nodes.rows.map((node) => ({ id: node.id, status: node.status, dependsOn: node.depends_on })))) {
        const verification = await verifyPlanIntegration(client, identity.spaceId, plan.version_id);
        await finishPlan(client, identity.spaceId, planId, plan.root_run_id, "failed", "A plan node failed or was cancelled", verification);
        return { plan_id: planId, status: "failed", scheduled_node_ids: [] };
      }
      if (this.scheduler.isComplete(nodes.rows.map((node) => ({ id: node.id, status: node.status, dependsOn: node.depends_on })))) {
        const verification = await verifyPlanIntegration(client, identity.spaceId, plan.version_id);
        const status = verification.status === "passed" ? "succeeded" : "failed";
        await finishPlan(client, identity.spaceId, planId, plan.root_run_id, status, status === "succeeded" ? "All plan nodes completed" : verification.summary, verification);
        return { plan_id: planId, status: status === "succeeded" ? "completed" : "failed", scheduled_node_ids: [] };
      }
      const scheduled = await this.scheduleReadyNodes(client, identity, {
        planId,
        planVersionId: plan.version_id,
        rootRunId: plan.root_run_id,
        projectFolderId: plan.project_folder_id,
        projectId: plan.project_id,
        agentId: plan.root_agent_id ?? "",
        runtimeProfileId: plan.root_runtime_profile_id,
        runtimeProfileSelectionSource: plan.root_runtime_profile_id ? "explicit" : "default",
        budgetSources: budgetSourcesFromPlan(plan.version_budget_json),
        userPrompt: plan.root_prompt,
        workflowInputJson: null,
      });
      return { plan_id: planId, status: "active", scheduled_node_ids: scheduled };
    });
  }

  async reconcileForRun(spaceId: string, runId: string, userId?: string): Promise<void> {
    const result = await this.db.query<{ plan_id: string; owner_user_id: string | null }>(
      `SELECT DISTINCT p.id AS plan_id, root.owner_user_id
         FROM plan_node_runs pnr JOIN plan_nodes n ON n.id = pnr.plan_node_id AND n.space_id = pnr.space_id
         JOIN plan_versions v ON v.id = n.plan_version_id AND v.space_id = n.space_id
         JOIN plans p ON p.id = v.plan_id AND p.space_id = v.space_id
         LEFT JOIN runs root ON root.id = p.root_run_id AND root.space_id = p.space_id
        WHERE pnr.space_id = $1 AND pnr.run_id = $2`,
      [spaceId, runId],
    );
    for (const row of result.rows) await this.reconcilePlan({ spaceId, userId: userId ?? row.owner_user_id ?? "system" }, row.plan_id);
  }

  private async assertPlanningRun(client: Queryable, identity: SpaceUserIdentity, input: AgentPlanProposalInput): Promise<void> {
    const result = await client.query<{ id: string }>(
      `SELECT r.id
         FROM runs r JOIN task_runs tr ON tr.run_id = r.id AND tr.space_id = r.space_id
        WHERE r.id = $1 AND r.space_id = $2 AND r.agent_id = $3 AND r.run_type = 'planning'
          AND r.instructed_by_user_id = $4 AND tr.task_id = $5 AND tr.role = 'planning'
        FOR SHARE`,
      [input.planningRunId, identity.spaceId, input.agentId, identity.userId, input.sourceTaskId],
    );
    if (!result.rows[0]) throw new HttpError(403, "Plan proposal must originate from the Agent planning Run for this Task");
  }

  private async projectLatestNodeRuns(client: Queryable, spaceId: string, planVersionId: string): Promise<void> {
    await client.query(
      `WITH latest AS (
         SELECT n.id AS node_id, r.status AS run_status, evaluation.outcome_status
           FROM plan_nodes n
           JOIN LATERAL (
             SELECT pnr.run_id FROM plan_node_runs pnr
              WHERE pnr.plan_node_id = n.id AND pnr.space_id = n.space_id
              ORDER BY pnr.created_at DESC, pnr.id DESC LIMIT 1
           ) link ON true
           JOIN runs r ON r.id = link.run_id AND r.space_id = n.space_id
           LEFT JOIN LATERAL (
             SELECT re.outcome_status FROM run_evaluations re
              WHERE re.run_id = r.id AND re.space_id = r.space_id
              ORDER BY re.evaluated_at DESC, re.id DESC LIMIT 1
           ) evaluation ON true
          WHERE n.space_id = $1 AND n.plan_version_id = $2
       )
       UPDATE plan_nodes n SET status = CASE
         WHEN latest.run_status IN ('failed', 'cancelled', 'orphaned') THEN 'failed'
         WHEN latest.run_status IN ('succeeded', 'degraded') AND latest.outcome_status = 'passed' THEN 'done'
         WHEN latest.run_status IN ('succeeded', 'degraded') AND latest.outcome_status IS NOT NULL THEN 'failed'
         ELSE n.status END,
         blocked_reason = CASE WHEN latest.run_status IN ('failed', 'cancelled', 'orphaned') THEN 'Node Run failed' ELSE n.blocked_reason END,
         updated_at = now()
        FROM latest
       WHERE n.id = latest.node_id
         AND (latest.run_status IN ('failed', 'cancelled', 'orphaned') OR latest.outcome_status IS NOT NULL)`,
      [spaceId, planVersionId],
    );
  }

  private async scheduleReadyNodes(client: Queryable, identity: SpaceUserIdentity, input: {
    planId: string;
    planVersionId: string;
    rootRunId: string;
    projectFolderId: string | null;
    projectId: string | null;
    agentId: string;
    runtimeProfileId: string | null;
    runtimeProfileSelectionSource: "explicit" | "default";
    budgetSources: RunBudgetSource[];
    userPrompt: string | null;
    workflowInputJson: Record<string, unknown> | null;
  }): Promise<string[]> {
    const result = await client.query<PlanNodeRow & { depends_on: string[] }>(
      `SELECT n.id, n.space_id, n.plan_version_id, n.node_key, n.node_kind, n.title,
              n.description, n.status, n.assigned_agent_id, n.runtime_profile_id,
              n.capability_id, n.prompt_asset_key, n.risk_level,
              n.acceptance_criteria_json, n.definition_of_done, n.required_outputs_json,
              n.input_bindings_json,
              n.max_runs, n.max_cost, n.max_duration_seconds, n.policy_json,
              n.verification_recipe_refs_json, n.budget_sources_json, n.metadata_json, n.blocked_reason,
              n.content_hash, n.approval_proposal_id, n.created_at, n.updated_at,
              COALESCE(array_agg(d.depends_on_node_id) FILTER (WHERE d.depends_on_node_id IS NOT NULL), ARRAY[]::varchar[]) AS depends_on
         FROM plan_nodes n LEFT JOIN plan_node_dependencies d ON d.node_id = n.id AND d.space_id = n.space_id
        WHERE n.space_id = $1 AND n.plan_version_id = $2 AND n.status IN ('inbox', 'ready')
        GROUP BY n.id ORDER BY n.created_at ASC, n.id ASC`,
      [identity.spaceId, input.planVersionId],
    );
    const scheduled: string[] = [];
    const queue = new PgJobQueueRepository(client);
    const statusResult = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM plan_nodes WHERE space_id = $1 AND plan_version_id = $2`,
      [identity.spaceId, input.planVersionId],
    );
    const dependenciesById = new Map(result.rows.map((node) => [node.id, node.depends_on]));
    const readyNodeIds = new Set(this.scheduler.readyNodes(statusResult.rows.map((node) => ({
      id: node.id,
      status: node.status,
      dependsOn: dependenciesById.get(node.id) ?? [],
    }))).map((node) => node.id));
    for (const node of result.rows) {
      if (!readyNodeIds.has(node.id)) continue;
      if (node.node_kind === "approval_checkpoint") {
        if (node.approval_proposal_id) continue;
        const proposalId = randomUUID();
        const now = new Date().toISOString();
        await client.query(
          `INSERT INTO proposals (id, space_id, proposal_type, status, risk_level, urgency, title, summary,
             payload_json, created_at, updated_at, created_by_user_id, owner_user_id, project_id, project_folder_id)
           VALUES ($1, $2, 'plan_checkpoint', 'pending', $3, 'normal', $4, $5, $6::jsonb, $7, $7, $8, $8, $9, $10)`,
          [proposalId, identity.spaceId, node.risk_level, `Approve plan checkpoint: ${node.title}`,
            "This Plan Node is an explicit approval checkpoint.", JSON.stringify({ plan_id: input.planId, plan_version_id: input.planVersionId, node_id: node.id }), now, identity.userId, input.projectId, input.projectFolderId],
        );
        await client.query(`UPDATE plan_nodes SET status = 'waiting_for_review', approval_proposal_id = $3, blocked_reason = $4, updated_at = $5 WHERE space_id = $1 AND id = $2`, [identity.spaceId, node.id, proposalId, "Approval checkpoint is pending", now]);
        scheduled.push(node.id);
        continue;
      }
      if (node.node_kind === "integration") {
        const verification = await verifyIntegrationNode(client, identity.spaceId, node.id, node.depends_on);
        const now = new Date().toISOString();
        await client.query(`UPDATE plan_nodes SET status = $3, blocked_reason = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END, updated_at = $5 WHERE space_id = $1 AND id = $2`, [identity.spaceId, node.id, verification.status === "passed" ? "done" : "failed", verification.summary, now]);
        scheduled.push(node.id);
        continue;
      }
      const childAgentId = node.assigned_agent_id ?? input.agentId;
      let resolvedInputs;
      try {
        resolvedInputs = await resolveNodeInputs(client, {
          spaceId: identity.spaceId,
          bindings: node.input_bindings_json,
          sourceTable: "plan_nodes",
          linkTable: "plan_node_runs",
          linkNodeColumn: "plan_node_id",
          scopeColumn: "plan_version_id",
          scopeId: input.planVersionId,
        });
      } catch (error) {
        if (!(error instanceof InputBindingResolutionError)) throw error;
        const now = new Date().toISOString();
        await client.query(
          `UPDATE plan_nodes SET status = 'failed', blocked_reason = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
          [identity.spaceId, node.id, `input_binding_unresolved:${error.bindingName}:${error.reason}`, now],
        );
        scheduled.push(node.id);
        continue;
      }
      const nodeBudgetSources = budgetSourcesForNode(node, input.budgetSources, input.planId);
      await assertBudgetSourcesAvailable(client, identity.spaceId, nodeBudgetSources, { excludeExecutionRootId: input.rootRunId });
      const child = await new PgRunRepository(client).createQueuedRun({
        agent_id: childAgentId,
        space_id: identity.spaceId,
        user_id: identity.userId,
        mode: "live",
        run_type: "workflow",
        trigger_origin: "job",
        parent_run_id: input.rootRunId,
        root_run_id: input.rootRunId,
        project_folder_id: input.projectFolderId,
        project_id: input.projectId,
        prompt: input.userPrompt ?? node.title,
        instruction: node.description ? `Plan Node: ${node.title}\n\n${node.description}${workflowInputSuffix(input.workflowInputJson)}` : `Plan Node: ${node.title}${workflowInputSuffix(input.workflowInputJson)}`,
        runtime_profile_id: node.runtime_profile_id ?? input.runtimeProfileId,
        runtime_profile_selection_source: node.runtime_profile_id ? "explicit" : input.runtimeProfileSelectionSource,
        capability_id: node.capability_id,
        context_artifact_ids: resolvedInputs.contextArtifactIds,
        contract_snapshot: {
          source: { kind: "plan", id: input.planId },
          project_id: input.projectId,
          project_folder_id: input.projectFolderId,
          acceptance_criteria_json: node.acceptance_criteria_json,
          definition_of_done: node.definition_of_done,
          required_outputs_json: node.required_outputs_json,
          risk_level: node.risk_level,
          max_runs: node.max_runs,
          max_cost: node.max_cost,
          max_duration_seconds: node.max_duration_seconds,
          budget_sources: nodeBudgetSources,
          workflow_input_json: input.workflowInputJson,
          upstream_inputs_json: resolvedInputs,
          route_hints_json: {
            ...recordValue(node.policy_json),
            plan_id: input.planId,
            plan_version_id: input.planVersionId,
            plan_node_id: node.id,
            node_key: node.node_key,
            verification_recipe_refs: node.verification_recipe_refs_json,
          },
        },
      });
      const now = new Date().toISOString();
      await client.query(`INSERT INTO plan_node_runs (id, space_id, plan_node_id, run_id, role, resolved_inputs_json, created_at) VALUES ($1, $2, $3, $4, 'primary', $5::jsonb, $6) ON CONFLICT (plan_node_id, run_id) DO NOTHING`, [randomUUID(), identity.spaceId, node.id, child.id, JSON.stringify(resolvedInputs), now]);
      await client.query(`UPDATE plan_nodes SET status = 'in_progress', updated_at = $3 WHERE space_id = $1 AND id = $2`, [identity.spaceId, node.id, now]);
      await queue.enqueue({ job_type: "agent_run", space_id: identity.spaceId, user_id: identity.userId, agent_id: childAgentId, project_folder_id: input.projectFolderId, payload: { run_id: child.id, plan_id: input.planId, plan_version_id: input.planVersionId, plan_node_id: node.id } });
      scheduled.push(node.id);
    }
    return scheduled;
  }
}

async function insertPlanVersion(client: Queryable, input: {
  id: string;
  planId: string;
  spaceId: string;
  version: number;
  referenceWorkflowVersionId: string | null;
  planningRunId: string;
  planningToolCallId: string;
  plannerMode: "agent";
  status: string;
  graph: MaterializedPlanGraph;
  budgetCap: number | null;
  budgetSources: RunBudgetSource[];
  budgetAuthority: Omit<CanonicalBudgetAuthority, "ownership"> & {
    ownership: Array<CanonicalBudgetAuthority["ownership"][number] | {
      source: RunBudgetSource["source"];
      authority: "plan_declaration";
    }>;
  };
  plannerMetadata: Record<string, unknown> | null;
  agentId: string;
  now: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO plan_versions (
       id, space_id, plan_id, version, reference_workflow_version_id, planner_mode,
       status, approval_proposal_id, planning_run_id, planning_tool_call_id,
       node_count, depth, budget_json, definition_json, created_by_agent_id,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $15)`,
    [input.id, input.spaceId, input.planId, input.version, input.referenceWorkflowVersionId, input.plannerMode, input.status,
      input.planningRunId, input.planningToolCallId, input.graph.nodes.length, input.graph.depth,
      JSON.stringify({
        cap: input.budgetCap,
        sources: input.budgetSources,
        effective: input.budgetAuthority.effective,
        resolution: input.budgetAuthority.resolution,
        ownership: input.budgetAuthority.ownership,
      }),
      JSON.stringify({ graphVersion: input.graph.graphVersion, definition: input.graph.definition, planner_metadata: input.plannerMetadata ?? {} }), input.agentId, input.now],
  );
}

async function insertPlanNodes(client: Queryable, spaceId: string, planVersionId: string, graph: MaterializedPlanGraph, versionStatus: string, now: string): Promise<void> {
  const ids = new Map<string, string>();
  for (const node of graph.nodes) {
    const id = randomUUID();
    ids.set(node.key, id);
    await client.query(
      `INSERT INTO plan_nodes (
         id, space_id, plan_version_id, node_key, node_kind, title, description, status,
         assigned_agent_id, runtime_profile_id, capability_id, prompt_asset_key, risk_level,
         acceptance_criteria_json, definition_of_done, required_outputs_json, input_bindings_json, max_runs,
         max_cost, max_duration_seconds, policy_json, verification_recipe_refs_json,
         budget_sources_json, metadata_json, content_hash, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                 $15, $16::jsonb, $17::jsonb, $18, $19, $20, $21::jsonb, $22::jsonb, $23::jsonb, $24::jsonb, $25, $26, $26)`,
      [id, spaceId, planVersionId, node.key, node.kind, node.title, node.description,
        versionStatus === "approved" ? "inbox" : "blocked", node.agentId, node.runtimeProfileId,
        node.capabilityId, node.promptAssetKey, stringValue(node.contractJson.risk_level) ?? "low",
        JSON.stringify(node.contractJson.acceptance_criteria_json ?? null), stringValue(node.contractJson.definition_of_done),
        JSON.stringify(node.contractJson.required_outputs_json ?? null), JSON.stringify(node.inputBindings), positiveIntegerOrNull(node.contractJson.max_runs),
        nonNegativeNumberOrNull(node.contractJson.max_cost), positiveIntegerOrNull(node.contractJson.max_duration_seconds),
        JSON.stringify(node.contractJson.policy_json ?? node.contractJson.route_hints_json ?? {}), JSON.stringify(node.verificationRecipeRefs),
        JSON.stringify(budgetSourcesFromNode(node)), JSON.stringify(node.metadataJson), planNodeContentHash(node), now],
    );
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      const nodeId = ids.get(node.key);
      const dependsOnNodeId = ids.get(dependency);
      if (!nodeId || !dependsOnNodeId) throw new HttpError(500, "Plan dependency materialization failed");
      await client.query(`INSERT INTO plan_node_dependencies (id, space_id, plan_version_id, node_id, depends_on_node_id, dependency_type, created_at) VALUES ($1, $2, $3, $4, $5, 'requires', $6)`, [randomUUID(), spaceId, planVersionId, nodeId, dependsOnNodeId, now]);
    }
  }
}

function budgetSourcesForNode(
  node: PlanNodeRow,
  inherited: RunBudgetSource[],
  planId: string,
): RunBudgetSource[] {
  const sources = [...inherited];
  const declared = Array.isArray(node.budget_sources_json) ? node.budget_sources_json.filter((value): value is RunBudgetSource => {
    const source = recordValue(recordValue(value).source).kind;
    return ["direct", "space", "task", "automation", "workflow", "delegation", "plan"].includes(String(source));
  }) : [];
  sources.push(...declared);
  if (node.max_runs !== null || node.max_cost !== null || node.max_duration_seconds !== null) {
    sources.push({
      source: { kind: "plan", id: planId },
      max_runs: node.max_runs,
      max_cost: node.max_cost,
      max_duration_seconds: node.max_duration_seconds,
    });
  }
  return sources;
}

function budgetSourcesFromPlan(value: unknown): RunBudgetSource[] {
  const sources = recordValue(value).sources;
  return Array.isArray(sources) ? sources.filter((item): item is RunBudgetSource => ["direct", "space", "task", "automation", "workflow", "delegation", "plan"].includes(String(recordValue(recordValue(item).source).kind))) : [];
}

function declaredBudgetCap(value: unknown): number | null {
  const cap = recordValue(value).budget_cap;
  return typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : null;
}

function highestRisk(graph: MaterializedPlanGraph): string {
  const order = ["low", "medium", "high", "critical"];
  return graph.nodes.reduce((highest, node) => {
    const risk = stringValue(node.contractJson.risk_level) ?? "low";
    return order.indexOf(risk) > order.indexOf(highest) ? risk : highest;
  }, "low");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

function workflowInputSuffix(value: Record<string, unknown> | null): string {
  return value && Object.keys(value).length > 0 ? `\n\nInput (JSON): ${JSON.stringify(value)}` : "";
}

function finishPlan(client: Queryable, spaceId: string, planId: string, rootRunId: string, status: "succeeded" | "failed", summary: string, verification: unknown): Promise<void> {
  const now = new Date().toISOString();
  return (async () => {
    await client.query(`UPDATE plans SET status = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`, [spaceId, planId, status === "succeeded" ? "completed" : "failed", now]);
    await new PgRunRepository(client).markRunTerminal({
      run_id: rootRunId,
      space_id: spaceId,
      status,
      output_text: summary,
      output_json: canonicalRunOutput({
        success: status === "succeeded",
        outputText: summary,
        outputJson: { plan_id: planId, summary, coordinator: true, integration_verification: verification },
      }),
      error_json: status === "failed" ? { error_code: "plan_node_failed", error_text: summary } : {},
      exit_code: status === "failed" ? 1 : 0,
      completed_at: now,
    });
  })();
}
