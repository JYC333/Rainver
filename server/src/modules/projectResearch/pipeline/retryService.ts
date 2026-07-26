import type { Queryable, SpaceUserIdentity } from "../../routeUtils/common";
import { HttpError } from "../../routeUtils/common";
import { assertProjectWriter } from "../../projects/access";
import type { ResearchOperationState, ResearchStage, ResearchMutationResult } from "../operationProjection";
import { researchStage, researchState } from "../operationProjection";

export interface RetryOperationRow {
  id: string;
  space_id: string;
  project_id: string;
  status: string;
  progress_json: unknown;
}

interface QueueSynthesisInput {
  spaceId: string;
  userId: string;
  projectId: string;
  operationId: string;
  workflowId: string;
  from: readonly ResearchStage[];
  reuseExistingRun: boolean;
}

interface QueueComparisonInput {
  spaceId: string;
  userId: string;
  projectId: string;
  operationId: string;
  workflowId: string;
}

export interface ProjectResearchRetryPorts<TRead, TSetup> {
  operation(spaceId: string, operationId: string): Promise<RetryOperationRow | null>;
  assertQuestionAligned(spaceId: string, projectId: string, workflowId: string): Promise<void>;
  activeOperation(spaceId: string, projectId: string, workflowId: string): Promise<RetryOperationRow | null>;
  retryMonitorSetup(identity: SpaceUserIdentity, projectId: string, state: ResearchOperationState): Promise<TSetup>;
  ensureProcessingBatchSize(identity: SpaceUserIdentity, ruleIds: string[]): Promise<void>;
  setState(operation: RetryOperationRow, state: ResearchOperationState): Promise<void>;
  enqueueReconcile(spaceId: string, userId: string, operationId: string, reason: string): Promise<void>;
  failOperation(operation: RetryOperationRow, message: string): Promise<void>;
  readOperation(identity: SpaceUserIdentity, projectId: string, operationId: string): Promise<TRead>;
  queueSynthesis(input: QueueSynthesisInput): Promise<ResearchMutationResult>;
  queueComparison(input: QueueComparisonInput): Promise<ResearchMutationResult>;
  retryBackfill(spaceId: string, planId: string): Promise<void>;
}

/** Owns retry routing and idempotency; stage coordinators still own execution. */
export class ProjectResearchRetryService<TRead, TSetup> {
  constructor(
    private readonly db: Queryable,
    private readonly ports: ProjectResearchRetryPorts<TRead, TSetup>,
  ) {}

  async retry(identity: SpaceUserIdentity, projectId: string, operationId: string): Promise<TRead | TSetup> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const operation = await this.ports.operation(identity.spaceId, operationId);
    if (!operation || operation.project_id !== projectId) throw new HttpError(404, "Research operation not found");
    if (operation.status !== "failed") throw new HttpError(409, "Only failed research operations can be retried");
    const state = researchState(operation.progress_json);
    await this.ports.assertQuestionAligned(identity.spaceId, projectId, state.workflow_id);
    const active = state.workflow_id
      ? await this.ports.activeOperation(identity.spaceId, projectId, state.workflow_id)
      : null;
    if (active && active.id !== operation.id) {
      throw new HttpError(409, "Another Project Research operation is already active for this workflow");
    }
    const failedStage = researchStage(state.failed_stage ?? state.current_stage);
    if (state.run_kind === "baseline" && failedStage === "monitor_setup") {
      return this.ports.retryMonitorSetup(identity, projectId, state);
    }

    const backfillPlanIds = state.source_backfill_plan_ids?.length
      ? state.source_backfill_plan_ids
      : state.source_backfill_plan_id ? [state.source_backfill_plan_id] : [];
    const ruleIds = unique([
      ...state.source_post_processing_rule_ids,
      ...(state.source_post_processing_rule_id ? [state.source_post_processing_rule_id] : []),
    ]);
    if (
      (state.run_kind === "baseline" || state.run_kind === "historical_backfill")
      && (failedStage === "backfill" || failedStage === "screening")
      && ruleIds.length > 0
    ) {
      await this.ports.ensureProcessingBatchSize(identity, ruleIds);
      const failedPlans = backfillPlanIds.length
        ? await this.db.query<{ id: string }>(
          `SELECT id FROM source_backfill_plans
             WHERE space_id=$1 AND id=ANY($2::text[]) AND status='failed'`,
          [identity.spaceId, backfillPlanIds],
        )
        : { rows: [] as Array<{ id: string }> };
      if (failedStage === "backfill" && failedPlans.rows.length > 0) {
        state.current_stage = "backfill";
        state.stage_state = "running";
        delete state.failed_stage;
        await this.ports.setState(operation, state);
        try {
          for (const plan of failedPlans.rows) await this.ports.retryBackfill(identity.spaceId, plan.id);
          await this.ports.enqueueReconcile(identity.spaceId, identity.userId, operation.id, "retry_backfill");
        } catch (error) {
          await this.ports.failOperation(operation, error instanceof Error ? error.message : "Research backfill retry failed");
          throw error;
        }
        return this.ports.readOperation(identity, projectId, operation.id);
      }

      state.current_stage = "screening";
      state.stage_state = "running";
      state.post_processing_recovery_requested_at = new Date().toISOString();
      state.screening_progress = state.screening_progress
        ? { ...state.screening_progress, phase: "preparing_batches", started_at: state.post_processing_recovery_requested_at, message: "Preparing screening batches for retry." }
        : undefined;
      delete state.failed_stage;
      await this.ports.setState(operation, state);
      await this.ports.enqueueReconcile(identity.spaceId, identity.userId, operation.id, "retry_screening");
      return this.ports.readOperation(identity, projectId, operation.id);
    }

    if (failedStage === "synthesis") {
      await this.ports.queueSynthesis({
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectId,
        operationId: operation.id,
        workflowId: state.workflow_id,
        from: ["failed"],
        reuseExistingRun: false,
      });
      return this.ports.readOperation(identity, projectId, operation.id);
    }

    if (failedStage === "comparison") {
      // queueComparison reloads and mutates the operation's persisted state
      // itself (see MonitoringCoordinator.queueComparison) — it takes only
      // ids, not `state`, so mutating the local `state` object here has no
      // effect and previously read as if it reset something it doesn't.
      await this.ports.queueComparison({
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectId,
        operationId: operation.id,
        workflowId: state.workflow_id,
      });
      return this.ports.readOperation(identity, projectId, operation.id);
    }

    state.current_stage = failedStage;
    delete state.failed_stage;
    state.stage_state = "running";
    await this.ports.setState(operation, state);
    try {
      if (failedStage === "backfill" && state.source_backfill_plan_id) {
        await this.ports.retryBackfill(identity.spaceId, state.source_backfill_plan_id);
      } else {
        await this.ports.enqueueReconcile(identity.spaceId, identity.userId, operation.id, "retry");
      }
    } catch (error) {
      await this.ports.failOperation(operation, error instanceof Error ? error.message : "Research retry failed");
      throw error;
    }
    return this.ports.readOperation(identity, projectId, operation.id);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
