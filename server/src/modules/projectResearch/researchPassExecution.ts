import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import {
  HttpError,
  objectValue,
  optionalString,
  withQueryableTransaction,
} from "../routeUtils/common";
import { lockActiveProjectForMutation } from "../projects/access";
import { WorkflowExecutionService } from "../automations/workflowExecutionService";
import {
  actionNodeHandlerRegistry,
  ActionNodeHandlerError,
} from "../automations/actionNodeRegistry";
import { workflowExecutionOutcomeHandlerRegistry } from "../automations/workflowExecutionOutcomeRegistry";
import { findOrCreateResearchAutomation } from "./synthesisOnlyExecution";
import { researchState } from "./operationProjection";
import { isRetryableRunErrorCode } from "../runs/retryPolicy";

const RESEARCH_PASS_WORKFLOW_ID = "academic_literature_review.reconcile_pass";
const RESEARCH_PASS_ACTION_KEY = "project_research.reconcile_pass";
const RESEARCH_APPLY_RUN_ACTION_KEY = "project_research.apply_stage_run";
const RESEARCH_PASS_TEMPLATE_ASSET_KEY = "academic_literature_review.reconcile_pass";

interface ResearchOperationForPass {
  id: string;
  project_id: string;
  status: string;
  progress_json: unknown;
}

export type ResearchPassEvent =
  | { kind: "reconcile" }
  | { kind: "run_terminal"; runId: string }
  | {
      kind: "checkpoint_resume";
      userId: string;
      projectId: string;
      workflowId: string;
      checkpointId: string;
    }
  | { kind: "retry"; userId: string; projectId: string }
  | {
      kind: "empty_scan";
      sourceChannelId: string | null;
      scanJobId: string;
      scannedAt: string;
      scanWindowStart: string | null;
      scanWindowEnd: string | null;
      newItemCount: number;
    };

/**
 * Starts one immutable WorkflowExecution for one observation/reconciliation
 * pass. A Project Research operation may have many passes over its lifetime,
 * but an execution is never reopened and never contains a graph cycle.
 */
export async function startResearchReconcilePass(
  db: Queryable,
  identity: SpaceUserIdentity,
  config: ServerConfig,
  operation: ResearchOperationForPass,
  reason: string,
  event: ResearchPassEvent = { kind: "reconcile" },
): Promise<string | null> {
  return withQueryableTransaction(db, async (tx) => {
    await lockActiveProjectForMutation(
      tx,
      identity.spaceId,
      operation.project_id,
    );
    return startResearchReconcilePassLocked(
      tx,
      identity,
      config,
      operation,
      reason,
      event,
    );
  });
}

async function startResearchReconcilePassLocked(
  db: Queryable,
  identity: SpaceUserIdentity,
  config: ServerConfig,
  operation: ResearchOperationForPass,
  reason: string,
  event: ResearchPassEvent,
): Promise<string | null> {
  const current = await db.query<ResearchOperationForPass>(
    `SELECT id,project_id,status,progress_json FROM project_operations
      WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,
    [operation.id, identity.spaceId, operation.project_id],
  );
  const lockedOperation = current.rows[0];
  if (!lockedOperation || ["completed", "cancelled"].includes(lockedOperation.status)) return null;
  const active = await db.query<{ id: string }>(
    `SELECT id FROM workflow_executions
      WHERE space_id=$1 AND research_operation_id=$2
        AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`,
    [identity.spaceId, lockedOperation.id],
  );
  if (active.rows[0]) {
    await settleSynchronousNodes(
      db,
      identity,
      config,
      active.rows[0].id,
    );
    return active.rows[0].id;
  }
  if (lockedOperation.status === "failed" && event.kind !== "retry") return null;
  if (event.kind === "retry" && lockedOperation.status !== "failed") return null;

  const state = researchState(lockedOperation.progress_json);
  const automation = await findOrCreateResearchAutomation(
    db,
    identity,
    lockedOperation.project_id,
    state.agent_id,
  );
  const versionId = await findOrCreateResearchPassTemplateVersion(db, identity);
  const result = await new WorkflowExecutionService(config).start({
    db,
    identity,
    automation,
    target: {
      versionId,
      resolutionTrace: [
        `project_research_operation:${lockedOperation.id}`,
        `reason:${reason}`,
      ],
      contentJson: researchPassDefinition(lockedOperation.id, reason, event),
    },
    triggerType: "project_research_event",
    inputJson: {
      project_research: {
        operation_id: lockedOperation.id,
        run_kind: state.run_kind,
        reason,
        event,
      },
    },
    preflightSnapshot: { executable: true },
    budgetSources: [],
    researchOperationId: lockedOperation.id,
    beforeSchedule: async (executionId) => {
      const updated = await db.query(
        `UPDATE project_operations
            SET current_execution_id=$3,
                generation=generation+1,
                updated_at=$4
          WHERE id=$1 AND space_id=$2
            AND status NOT IN ('completed','cancelled')`,
        [lockedOperation.id, identity.spaceId, executionId, new Date().toISOString()],
      );
      if (updated.rowCount !== 1) {
        throw new HttpError(409, "Project Research operation is no longer active");
      }
    },
  });
  await settleSynchronousNodes(db, identity, config, result.workflowExecutionId);
  return result.workflowExecutionId;
}

function researchPassDefinition(
  operationId: string,
  reason: string,
  event: ResearchPassEvent = { kind: "reconcile" },
): Record<string, unknown> {
  return {
    schema_version: "workflow_definition.v1",
    workflow_id: RESEARCH_PASS_WORKFLOW_ID,
    name: "Academic Literature Review — reconcile pass",
    description: "Applies one bounded observation pass to a Project Research operation.",
    input_schema_json: {},
    output_artifact_types: [],
    metadata_json: {},
    nodes: [
      {
        id: "reconcile",
        title: "Reconcile the current research stage",
        depends_on: [],
        contract_json: { max_attempts: 1 },
        metadata_json: {
          node_kind: "action",
          action_key: RESEARCH_PASS_ACTION_KEY,
          operation_id: operationId,
          reason,
          event,
        },
      },
      // Keep the immutable pass inside the governed Plan graph depth limit:
      // reconcile -> apply -> apply. Any later asynchronous Run completion
      // starts a new pass, so extending this chain would duplicate the outer
      // retry/re-entry authority and make the stored graph invalid.
      ...[1, 2].map((step) => ({
        id: `apply_stage_run_${step}`,
        title: `Apply research stage Run ${step}`,
        depends_on: [step === 1 ? "reconcile" : `apply_stage_run_${step - 1}`],
        input_bindings: [
          {
            name: "stage_run",
            from_node: step === 1 ? "reconcile" : `apply_stage_run_${step - 1}`,
            source: "output_json",
            json_pointer: "/operation_id",
            // The resolver deliberately prefers an upstream delegated Run.
            // Model outputs do not carry our Action's operation_id, but the
            // binding still supplies the delegated source_run_id that the
            // apply handler governs and validates.
            required: false,
          },
        ],
        contract_json: { max_attempts: 1 },
        metadata_json: {
          node_kind: "action",
          action_key: RESEARCH_APPLY_RUN_ACTION_KEY,
          operation_id: operationId,
        },
      })),
    ],
  };
}

async function findOrCreateResearchPassTemplateVersion(
  db: Queryable,
  identity: SpaceUserIdentity,
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT v.id FROM evolvable_asset_versions v
       JOIN evolvable_assets a ON a.id=v.asset_id
      WHERE a.asset_key=$1 AND v.space_id=$2 AND v.status='approved'
      ORDER BY v.version DESC LIMIT 1`,
    [RESEARCH_PASS_TEMPLATE_ASSET_KEY, identity.spaceId],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO evolvable_assets (
       id, space_id, asset_type, asset_key, display_name, description,
       owner_scope_type, owner_scope_id, status, metadata_json, created_at, updated_at
     ) VALUES ($1,$2,'workflow_template',$3,$4,$5,'space',$2,'active','{}'::jsonb,$6,$6)
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      identity.spaceId,
      RESEARCH_PASS_TEMPLATE_ASSET_KEY,
      "Academic Literature Review — reconcile pass",
      "One immutable execution-per-pass reconciliation step.",
      now,
    ],
  );
  const asset = await db.query<{ id: string }>(
    `SELECT id FROM evolvable_assets WHERE space_id=$1 AND asset_key=$2`,
    [identity.spaceId, RESEARCH_PASS_TEMPLATE_ASSET_KEY],
  );
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO evolvable_asset_versions (
       id, asset_id, space_id, scope_type, scope_id, version, status,
       source, content_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'space',$3,1,'approved','user_authored',$4::jsonb,$5,$5)
     ON CONFLICT (asset_id, version) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      asset.rows[0]!.id,
      identity.spaceId,
      JSON.stringify(researchPassDefinition("", "resolved_per_pass")),
      now,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const raced = await db.query<{ id: string }>(
    `SELECT id FROM evolvable_asset_versions WHERE asset_id=$1 AND version=1`,
    [asset.rows[0]!.id],
  );
  return raced.rows[0]!.id;
}

actionNodeHandlerRegistry.register(RESEARCH_PASS_ACTION_KEY, async (context) => {
  const operationId = optionalString(context.metadata.operation_id);
  if (!operationId) {
    throw new ActionNodeHandlerError("Research reconcile pass is missing operation_id");
  }
  const { ProjectResearchOrchestrator } = await import("./orchestrator.js");
  const orchestrator = new ProjectResearchOrchestrator(context.db, context.config);
  const event = objectValue(context.metadata.event) as Partial<ResearchPassEvent>;
  if (event.kind === "run_terminal" && optionalString(event.runId)) {
    await orchestrator.executeCompletedRunPass(
      context.identity.spaceId,
      optionalString(event.runId)!,
      context.executionId,
    );
  } else if (
    event.kind === "checkpoint_resume"
    && optionalString(event.userId)
    && optionalString(event.projectId)
    && optionalString(event.workflowId)
    && optionalString(event.checkpointId)
  ) {
    await orchestrator.executeCheckpointPass(
      context.identity.spaceId,
      optionalString(event.userId)!,
      optionalString(event.projectId)!,
      optionalString(event.workflowId)!,
      optionalString(event.checkpointId)!,
      context.executionId,
    );
  } else if (
    event.kind === "retry"
    && optionalString(event.userId)
    && optionalString(event.projectId)
  ) {
    await orchestrator.executeRetryPass(
      { spaceId: context.identity.spaceId, userId: optionalString(event.userId)! },
      optionalString(event.projectId)!,
      operationId,
      context.executionId,
    );
  } else if (
    event.kind === "empty_scan"
    && optionalString(event.scanJobId)
    && optionalString(event.scannedAt)
  ) {
    await orchestrator.executeEmptyScanPass(
      {
        spaceId: context.identity.spaceId,
        sourceChannelId: optionalString(event.sourceChannelId),
        scanJobId: optionalString(event.scanJobId)!,
        scannedAt: optionalString(event.scannedAt)!,
        scanWindowStart: optionalString(event.scanWindowStart),
        scanWindowEnd: optionalString(event.scanWindowEnd),
        newItemCount: typeof event.newItemCount === "number" ? event.newItemCount : 0,
      },
      operationId,
      context.executionId,
    );
  } else {
    await orchestrator.executeReconcilePass(
      context.identity.spaceId,
      operationId,
      context.executionId,
    );
  }
  const delegatedRunId = await delegatedRunForOperation(
    context.db,
    context.identity.spaceId,
    operationId,
  );
  return {
    output: {
      operation_id: operationId,
      reason: optionalString(context.metadata.reason),
    },
    ...(delegatedRunId ? { delegatedRunId } : {}),
  };
});

actionNodeHandlerRegistry.register(RESEARCH_APPLY_RUN_ACTION_KEY, async (context) => {
  const operationId = optionalString(context.metadata.operation_id);
  if (!operationId) {
    throw new ActionNodeHandlerError("Research stage application is missing operation_id");
  }
  const sourceRunId = context.bindings.find(
    (binding) => binding.name === "stage_run",
  )?.source_run_id;
  if (!sourceRunId || !(await isProjectResearchStageRun(
    context.db,
    context.identity.spaceId,
    sourceRunId,
    operationId,
  ))) {
    return { output: { operation_id: operationId, applied: false } };
  }
  const { ProjectResearchOrchestrator } = await import("./orchestrator.js");
  await new ProjectResearchOrchestrator(context.db, context.config).executeCompletedRunPass(
    context.identity.spaceId,
    sourceRunId,
    context.executionId,
  );
  const delegatedRunId = await delegatedRunForOperation(
    context.db,
    context.identity.spaceId,
    operationId,
  );
  return {
    output: { operation_id: operationId, applied: true, source_run_id: sourceRunId },
    ...(delegatedRunId && delegatedRunId !== sourceRunId ? { delegatedRunId } : {}),
  };
});

workflowExecutionOutcomeHandlerRegistry.register(
  RESEARCH_PASS_WORKFLOW_ID,
  async ({ db, spaceId, executionId, researchOperationId, status }) => {
    if (status !== "failed" || !researchOperationId) return;
    const row = await db.query<{ progress_json: unknown }>(
      `SELECT progress_json FROM project_operations
        WHERE id=$1 AND space_id=$2 AND current_execution_id=$3
          AND status NOT IN ('completed','cancelled')
        FOR UPDATE`,
      [researchOperationId, spaceId, executionId],
    );
    if (!row.rows[0]) return;
    const state = researchState(row.rows[0].progress_json);
    state.failed_stage = state.current_stage === "failed"
      ? state.failed_stage
      : state.current_stage;
    state.current_stage = "failed";
    state.stage_state = "failed";
    const failure = await latestExecutionRunFailure(db, spaceId, executionId);
    const runError = objectValue(failure?.error_json);
    const errorCode = optionalString(runError.error_code)
      ?? "workflow_execution_failed";
    const errorMessage = optionalString(runError.error_text)
      ?? failure?.error_message
      ?? "Research reconciliation pass failed";
    const workflowInput = objectValue(
      objectValue(failure?.contract_snapshot_json).workflow_input_json,
    );
    const researchInput = objectValue(workflowInput.project_research);
    state.error = {
      code: errorCode,
      message: errorMessage,
      at: new Date().toISOString(),
      diagnostics: {
        execution_id: executionId,
        ...(failure?.run_id ? { run_id: failure.run_id } : {}),
        ...(failure?.node_key ? { node_key: failure.node_key } : {}),
        ...(optionalString(researchInput.stage_key)
          ? { stage: optionalString(researchInput.stage_key) }
          : {}),
        ...(failure?.model_provider_id
          ? { model_provider_id: failure.model_provider_id }
          : {}),
        retryable: isRetryableRunErrorCode(errorCode),
        automatic_retry_exhausted:
          isRetryableRunErrorCode(errorCode)
          && failure?.automatic_retry_attempted === true,
      },
    };
    await db.query(
      `UPDATE project_operations
          SET status='failed', progress_json=$4::jsonb, updated_at=$5
        WHERE id=$1 AND space_id=$2 AND current_execution_id=$3`,
      [
        researchOperationId,
        spaceId,
        executionId,
        JSON.stringify(objectValue(state)),
        new Date().toISOString(),
      ],
    );
  },
);

async function latestExecutionRunFailure(
  db: Queryable,
  spaceId: string,
  executionId: string,
): Promise<{
  run_id: string;
  node_key: string;
  error_message: string | null;
  error_json: unknown;
  contract_snapshot_json: unknown;
  model_provider_id: string | null;
  automatic_retry_attempted: boolean;
} | null> {
  const result = await db.query<{
    run_id: string;
    node_key: string;
    error_message: string | null;
    error_json: unknown;
    contract_snapshot_json: unknown;
    model_provider_id: string | null;
    automatic_retry_attempted: boolean;
  }>(
    `SELECT r.id AS run_id, n.node_key, r.error_message, r.error_json,
            r.contract_snapshot_json, r.model_provider_id,
            EXISTS (
              SELECT 1 FROM run_supervisor_decisions decision
               WHERE decision.space_id=r.space_id AND decision.run_id=r.id
                 AND decision.decision IN ('retry_same_route','retry_fallback_route')
            ) AS automatic_retry_attempted
       FROM workflow_execution_nodes n
       JOIN workflow_execution_node_runs link
         ON link.space_id=n.space_id AND link.node_id=n.id
       JOIN runs r
         ON r.space_id=link.space_id AND r.id=link.run_id
      WHERE n.space_id=$1 AND n.execution_id=$2
        AND r.status IN ('failed','cancelled','orphaned')
      ORDER BY
        CASE WHEN link.role IN ('delegated','delegated_superseded') THEN 0 ELSE 1 END,
        r.updated_at DESC,
        r.id DESC
      LIMIT 1`,
    [spaceId, executionId],
  );
  return result.rows[0] ?? null;
}

async function delegatedRunForOperation(
  db: Queryable,
  spaceId: string,
  operationId: string,
): Promise<string | null> {
  const operation = await db.query<{ progress_json: unknown }>(
    `SELECT progress_json FROM project_operations WHERE id=$1 AND space_id=$2`,
    [operationId, spaceId],
  );
  if (!operation.rows[0]) return null;
  const state = researchState(operation.rows[0].progress_json);
  const candidates = [
    state.synthesis_critique?.run_id,
    state.comparison_run_id,
    state.synthesis_run_id,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (candidates.length === 0) return null;
  const run = await db.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE space_id=$1 AND id=ANY($2::varchar[])
        AND status IN ('queued','waiting_for_dependency','running')
      ORDER BY created_at DESC LIMIT 1`,
    [spaceId, candidates],
  );
  return run.rows[0]?.id ?? null;
}

async function isProjectResearchStageRun(
  db: Queryable,
  spaceId: string,
  runId: string,
  operationId: string,
): Promise<boolean> {
  const run = await db.query<{ contract_snapshot_json: unknown }>(
    `SELECT contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`,
    [runId, spaceId],
  );
  const projectResearch = objectValue(
    objectValue(run.rows[0]?.contract_snapshot_json).workflow_input_json,
  ).project_research;
  return optionalString(objectValue(projectResearch).operation_id) === operationId;
}

async function settleSynchronousNodes(
  db: Queryable,
  identity: SpaceUserIdentity,
  config: ServerConfig,
  executionId: string,
): Promise<void> {
  const service = new WorkflowExecutionService(config);
  // The reconcile pass has one producer plus two bounded application nodes.
  // A synchronous Action completion makes only its immediate successor ready,
  // so drain at most one graph-length worth of passes. A delegated model Run
  // leaves no newly scheduled node and exits the loop until Run finalization
  // calls WorkflowExecution reconciliation again.
  for (let index = 0; index < 4; index += 1) {
    const result = await service.reconcile(
      db,
      identity.spaceId,
      executionId,
      identity.userId,
    );
    const status = optionalString(result.status);
    if (status === "completed" || status === "failed") return;
    const scheduled = Array.isArray(result.scheduled_node_ids)
      ? result.scheduled_node_ids
      : [];
    if (scheduled.length === 0) return;
  }
}
