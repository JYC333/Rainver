import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../../config";
import type { Queryable } from "../../routeUtils/common";
import { objectValue, optionalString } from "../../routeUtils/common";
import type { SpaceUserIdentity } from "../../routeUtils/common";
import { HttpError } from "../../routeUtils/common";
import { syncProjectCorpusDecisionForSourceItem } from "../../projects/corpusRepository";
import { ResearchMonitoringCoordinator } from "../../research/queryPlanning/monitoringCoordinator";
import {
  COMPARISON_BATCH_SIZE,
  ProjectResearchMonitorComparisonService,
  parseMonitorComparisons,
  type MonitorComparison,
} from "../monitorComparisonService";
import {
  deriveSkippedAfterScreeningSteps,
  researchState,
  transition,
  updateProjection,
  type ResearchOperationState,
  type ResearchTransitionResult,
} from "../stateMachine";

interface MonitoringOperation {
  id: string;
  space_id: string;
  project_id: string;
}

interface ScanCounts {
  relevant: number;
  maybe: number;
  excluded: number;
}

export interface ResearchScanSummaryInput {
  spaceId: string;
  projectId: string;
  workflowId: string;
  operationId: string | null;
  scanKey: string;
  scanWindowStart: string | null;
  scanWindowEnd: string | null;
  scannedAt: string;
  newItemCount: number;
  relevantCount: number;
  maybeCount: number;
  excludedCount: number;
  onConflict?: "ignore" | "refresh_scan_time";
}

export interface ProjectResearchMonitoringPorts {
  projectWriterActor(spaceId: string, projectId: string): Promise<string | null>;
  screeningProgressFor(
    spaceId: string,
    projectId: string,
    operationId: string,
    state: ResearchOperationState,
    operationCreatedAt?: string,
  ): Promise<NonNullable<ResearchOperationState["screening_progress"]>>;
  hasResearchQuestionDrift(spaceId: string, projectId: string, workflow: unknown): Promise<boolean>;
  appendPendingIncrementalItems(spaceId: string, projectId: string, workflowId: string, itemIds: string[]): Promise<void>;
  reconcileOperation(spaceId: string, operationId: string): Promise<void>;
  activeHistoricalBackfill(spaceId: string, projectId: string, workflowId: string): Promise<MonitoringOperationRow | null>;
  backfillPlanForItems(spaceId: string, itemIds: string[]): Promise<Map<string, { last_plan_id: string | null; created_plan_id: string | null }>>;
  operationByIdempotency(spaceId: string, projectId: string, key: string): Promise<MonitoringOperationRow | null>;
  activeIncremental(spaceId: string, projectId: string, workflowId: string): Promise<MonitoringOperationRow | null>;
  createIncrementalOperation(input: {
    identity: SpaceUserIdentity;
    projectId: string;
    workflowState: unknown;
    workflowId: string;
    sourceItemIds: string[];
    idempotencyKey: string;
    watermarkAfter: string;
  }): Promise<MonitoringOperationRow>;
  operation(spaceId: string, operationId: string): Promise<MonitoringOperationRow | null>;
  failOperation(operation: MonitoringOperationRow, message: string): Promise<void>;
  setWorkflowMonitoring(spaceId: string, projectId: string, workflowId: string, state: ResearchOperationState): Promise<void>;
  reconcileCompletedRun(spaceId: string, runId: string): Promise<void>;
  enqueueIntegrityMonitor(
    spaceId: string,
    userId: string | null,
    projectId: string,
    workflowId: string,
    reason: string,
  ): Promise<void>;
}

export interface MonitoringOperationRow extends MonitoringOperation {
  status: string;
  progress_json: unknown;
  created_at?: string;
}

export interface SourceScanCompletedInput {
  spaceId: string;
  sourceChannelId: string | null;
  scanJobId: string;
  scannedAt: string;
  scanWindowStart: string | null;
  newItemCount: number;
}

/** Owns durable incremental-scan observations and adaptive query feedback. */
export class ProjectResearchMonitoringCoordinator {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig | undefined,
    private readonly ports: ProjectResearchMonitoringPorts,
  ) {}

  async onSourceScanCompleted(input: SourceScanCompletedInput): Promise<void> {
    if (!input.sourceChannelId || input.newItemCount > 0) return;
    const workflows = await this.db.query<{ id: string; project_id: string }>(
      `SELECT id, project_id
         FROM project_research_workflows
        WHERE space_id=$1 AND status='active'
          AND state_json @> $2::jsonb
          AND state_json @> '{"monitoring":{"active":true}}'::jsonb`,
      [input.spaceId, JSON.stringify({ channel_ids: [input.sourceChannelId] })],
    );
    for (const workflow of workflows.rows) {
      const operations = await this.db.query<{
        id: string; space_id: string; project_id: string; status: string; progress_json: unknown; created_at?: string;
      }>(
        `SELECT id, space_id, project_id, status, progress_json, created_at
           FROM project_operations
          WHERE space_id=$1 AND project_id=$2 AND kind='research'
            AND status='active'
            AND progress_json->>'workflow_id'=$3
            AND progress_json->>'run_kind'='incremental'
            AND COALESCE((progress_json->>'awaiting_source_scan')::boolean,false)=true
          ORDER BY created_at DESC LIMIT 1`,
        [input.spaceId, workflow.project_id, workflow.id],
      );
      const operation = operations.rows[0];
      if (!operation) {
        await this.insertScanSummary({
          spaceId: input.spaceId,
          projectId: workflow.project_id,
          workflowId: workflow.id,
          operationId: null,
          scanKey: `source-scan-day:${workflow.id}:${input.scannedAt.slice(0, 10)}`,
          scanWindowStart: input.scanWindowStart,
          scanWindowEnd: input.scannedAt,
          scannedAt: input.scannedAt,
          newItemCount: 0,
          relevantCount: 0,
          maybeCount: 0,
          excludedCount: 0,
          onConflict: "refresh_scan_time",
        });
        continue;
      }
      const state = researchState(operation.progress_json);
      const otherPending = await this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM extraction_jobs
          WHERE space_id=$1 AND id<>$2 AND job_type='connection_scan'
            AND status IN ('pending','running')
            AND metadata_json->>'source_channel_id' = ANY(
              ARRAY(SELECT jsonb_array_elements_text($3::jsonb))
            )`,
        [input.spaceId, input.scanJobId, JSON.stringify(state.channel_ids)],
      );
      if (Number(otherPending.rows[0]?.count ?? 0) > 0) continue;
      const pendingPostProcessing = await this.db.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM source_post_processing_runs
             WHERE space_id=$1 AND source_channel_id=ANY($2::text[]) AND status IN ('queued','running'))
           +
           (SELECT count(*) FROM jobs
             WHERE space_id=$1 AND job_type='source_post_processing_event' AND status IN ('pending','claimed','running')
               AND payload_json->>'source_channel_id'=ANY($2::text[]))
         )::text AS count`,
        [input.spaceId, state.channel_ids],
      );
      if (Number(pendingPostProcessing.rows[0]?.count ?? 0) > 0) continue;
      const progress = await this.ports.screeningProgressFor(
        input.spaceId,
        workflow.project_id,
        operation.id,
        state,
        operation.created_at,
      );
      const result = await transition(this.db, input.spaceId, operation.id, {
        from: ["monitor_setup", "backfill", "screening"],
        to: "complete",
        mutate: ({ state: current }) => {
          current.awaiting_source_scan = false;
          current.watermark = {
            before: current.watermark.after ?? input.scanWindowStart,
            after: input.scannedAt,
            overlap_hours: current.watermark.overlap_hours,
          };
          current.stage_state = "skipped";
          current.screening_progress = {
            ...progress,
            phase: "completed",
            total_items: 0,
            classified_items: 0,
            unclassified_items: 0,
            message: "The monitoring scan completed with no new papers.",
            updated_at: input.scannedAt,
          };
        },
        stepOverrides: deriveSkippedAfterScreeningSteps(),
      });
      if (result.applied && result.row && result.state) {
        await this.recordScanSummary(result.row, result.state, { relevant: 0, maybe: 0, excluded: 0 });
      }
    }
  }

  async reconcilePostProcessingRun(spaceId: string, runId: string): Promise<void> {
    const scope = await this.db.query<{ project_id: string | null; status: string; research_reconciled_at: string | null }>(
      `SELECT project_id,status,research_reconciled_at FROM source_post_processing_runs WHERE id=$1 AND space_id=$2`,
      [runId, spaceId],
    );
    const scopedRun = scope.rows[0];
    if (!scopedRun || scopedRun.status !== "succeeded" || !scopedRun.project_id || scopedRun.research_reconciled_at) return;
    const project = await this.db.query<{ status: string }>(
      `SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [scopedRun.project_id, spaceId],
    );
    if (!project.rows[0] || project.rows[0].status !== "active") {
      await this.markPostProcessingReconciled(spaceId, runId);
      return;
    }
    const result = await this.db.query<{
      id: string; project_id: string | null; source_channel_id: string; status: string;
      input_item_ids_json: unknown; triggered_by_user_id: string | null; research_reconciled_at: string | null;
    }>(
      `SELECT id, project_id, source_channel_id, status, input_item_ids_json, triggered_by_user_id,
              research_reconciled_at
         FROM source_post_processing_runs WHERE id=$1 AND space_id=$2 FOR UPDATE`,
      [runId, spaceId],
    );
    const run = result.rows[0];
    if (!run || run.status !== "succeeded" || !run.project_id || run.research_reconciled_at) return;
    if (run.project_id !== scopedRun.project_id) throw new HttpError(409, "Post-processing Project changed during reconciliation");
    const sourceItemIds = stringArray(run.input_item_ids_json);
    if (sourceItemIds.length === 0) {
      await this.markPostProcessingReconciled(spaceId, runId);
      return;
    }
    try {
      for (const sourceItemId of sourceItemIds) {
        await syncProjectCorpusDecisionForSourceItem(this.db, { spaceId, sourceItemId, projectId: run.project_id });
      }
      const workflows = await this.db.query<{ id: string; state_json: unknown }>(
        `SELECT id, state_json FROM project_research_workflows
          WHERE space_id=$1 AND project_id=$2 AND status='active' ORDER BY updated_at DESC LIMIT 1`,
        [spaceId, run.project_id],
      );
      const workflow = workflows.rows[0];
      if (!workflow) return;
      const state = researchState(workflow.state_json);
      if (!state.channel_ids.includes(run.source_channel_id)) return;
      if (await this.ports.hasResearchQuestionDrift(spaceId, run.project_id, workflow.state_json)) {
        await this.ports.appendPendingIncrementalItems(spaceId, run.project_id, workflow.id, sourceItemIds);
        return;
      }
      const cursor = await this.db.query<{ metadata_json: unknown }>(
        `SELECT metadata_json FROM scheduler_tasks WHERE task_type='source_channel_scan' AND task_key=$1 AND space_id=$2 LIMIT 1`,
        [run.source_channel_id, spaceId],
      );
      const watermarkAfter = optionalString(objectValue(objectValue(cursor.rows[0]?.metadata_json).cursor).last_published_at)
        ?? new Date().toISOString();
      const monitoringActive = objectValue(objectValue(workflow.state_json).monitoring).active === true || state.monitoring_active;
      if (!monitoringActive) {
        if (state.source_backfill_plan_id) {
          const baseline = await this.db.query<{ id: string }>(
            `SELECT id FROM project_operations
              WHERE space_id=$1 AND project_id=$2 AND kind='research'
                AND ($3 = ANY(ARRAY(SELECT jsonb_array_elements_text(COALESCE(progress_json->'source_backfill_plan_ids', '[]'::jsonb)))) OR progress_json->>'source_backfill_plan_id'=$4)
              ORDER BY created_at DESC LIMIT 1`,
            [spaceId, run.project_id, state.source_backfill_plan_id, state.source_backfill_plan_id],
          );
          if (baseline.rows[0]) await this.ports.reconcileOperation(spaceId, baseline.rows[0].id);
        }
        return;
      }
      const historical = await this.ports.activeHistoricalBackfill(spaceId, run.project_id, workflow.id);
      if (historical) {
        const origins = await this.ports.backfillPlanForItems(spaceId, sourceItemIds);
        const historicalPlanIds = researchState(historical.progress_json).source_backfill_plan_ids;
        const historicalIds = sourceItemIds.filter((id) => historicalPlanIds.includes(origins.get(id)?.created_plan_id ?? ""));
        const historicalUpdates = sourceItemIds.filter((id) => historicalPlanIds.includes(origins.get(id)?.last_plan_id ?? ""));
        const pendingIds = sourceItemIds.filter((id) => !historicalIds.includes(id) && !historicalUpdates.includes(id));
        if (historicalIds.length > 0) {
          await updateProjection(this.db, spaceId, historical.id, ({ state: current }) => {
            current.source_item_ids = unique([...current.source_item_ids, ...historicalIds]);
            current.watermark = { before: current.watermark.after, after: watermarkAfter, overlap_hours: current.watermark.overlap_hours };
          });
        }
        if (pendingIds.length > 0) await this.ports.appendPendingIncrementalItems(spaceId, run.project_id, workflow.id, pendingIds);
        await this.ports.reconcileOperation(spaceId, historical.id);
        return;
      }
      const idempotencyKey = `source-post-processing:${run.source_channel_id}:${sourceItemIds[0]}`;
      const prior = await this.ports.operationByIdempotency(spaceId, run.project_id, idempotencyKey);
      if (prior && prior.status !== "failed" && prior.status !== "cancelled") return;
      const active = await this.ports.activeIncremental(spaceId, run.project_id, workflow.id);
      if (active) {
        await updateProjection(this.db, spaceId, active.id, ({ state: current }) => {
          current.source_item_ids = unique([...current.source_item_ids, ...sourceItemIds]);
          current.awaiting_source_scan = false;
          current.watermark = { before: current.watermark.after, after: watermarkAfter, overlap_hours: current.watermark.overlap_hours };
        });
        await this.ports.reconcileOperation(spaceId, active.id);
        return;
      }
      const actor = run.triggered_by_user_id ?? await this.ports.projectWriterActor(spaceId, run.project_id);
      if (!actor) return;
      const created = await this.ports.createIncrementalOperation({
        identity: { spaceId, userId: actor }, projectId: run.project_id, workflowState: workflow.state_json,
        workflowId: workflow.id, sourceItemIds, idempotencyKey, watermarkAfter,
      });
      await this.ports.reconcileOperation(spaceId, created.id);
    } finally {
      await this.markPostProcessingReconciled(spaceId, runId);
    }
  }

  async queueComparison(input: {
    spaceId: string;
    userId: string;
    projectId: string;
    operationId: string;
    workflowId: string;
  }): Promise<ResearchTransitionResult> {
    const result = await transition(this.db, input.spaceId, input.operationId, {
      from: ["screening", "comparison", "failed"],
      to: "comparison",
      mutate: async ({ db, state }) => {
        state.stage_state = "running";
        if (state.current_stage === "failed") {
          // Resume, don't restart: the batch that was in flight when this
          // failed (comparison_source_item_ids) never got a queued
          // replacement, so put it back at the front of the pending queue
          // instead of dropping it. Leave comparison_pending_source_item_ids
          // (later batches) and comparison_results_json (already-classified
          // papers from earlier, successful batches) untouched — wiping them
          // here would silently discard real LLM output over one transient
          // bad batch and finalize the scan as "skipped" instead of retried.
          state.comparison_pending_source_item_ids = [
            ...(state.comparison_source_item_ids ?? []),
            ...(state.comparison_pending_source_item_ids ?? []),
          ];
          state.comparison_run_id = null;
          state.comparison_source_item_ids = [];
        }
        delete state.failed_stage;
        if (state.comparison_run_id) return;
        // First entry into the comparison stage: seed the batch queue from
        // scratch. A re-entry after a batch completed (comparison_run_id
        // cleared, comparison_pending_source_item_ids left over) keeps going
        // from where it left off instead of resetting.
        let pendingIds = state.comparison_pending_source_item_ids ?? [...state.source_item_ids];
        let failedIds = state.comparison_failed_source_item_ids ?? [];
        if (state.comparison_results_json === undefined) state.comparison_results_json = [];
        let degraded = state.comparison_degraded === true;
        const service = new ProjectResearchMonitorComparisonService(db);
        while (true) {
          // The pending pool batches normally (BATCH_SIZE at a time, or 1 at
          // a time once degraded); the failed pool — papers a batch already
          // failed to classify once — always retries one at a time, never
          // re-batched, so a second bad response only costs that one paper.
          const fromFailedPool = pendingIds.length === 0 && failedIds.length > 0;
          if (fromFailedPool) degraded = true;
          const pool = fromFailedPool ? failedIds : pendingIds;
          if (pool.length === 0) break;
          const size = fromFailedPool || degraded ? 1 : COMPARISON_BATCH_SIZE;
          const batch = pool.slice(0, size);
          const rest = pool.slice(size);
          const queued = await service.queue({
            spaceId: input.spaceId,
            userId: input.userId,
            projectId: input.projectId,
            workflowId: input.workflowId,
            operationId: input.operationId,
            agentId: state.agent_id,
            runtimeProfileId: state.runtime_profile_id || null,
            researchQuestion: state.research_question || "approved research corpus",
            sourceItemIds: batch,
          });
          if (fromFailedPool) failedIds = rest; else pendingIds = rest;
          if (queued) {
            state.comparison_run_id = queued.runId;
            state.comparison_source_item_ids = queued.sourceItemIds;
            state.comparison_pending_source_item_ids = pendingIds;
            state.comparison_failed_source_item_ids = failedIds;
            state.comparison_degraded = degraded;
            state.heartbeat_at = new Date().toISOString();
            return;
          }
          // Nothing in this batch was eligible (e.g. every paper in it was
          // screened out) — try the next one instead of stalling here.
        }
        state.comparison_pending_source_item_ids = pendingIds;
        state.comparison_failed_source_item_ids = failedIds;
        state.comparison_degraded = degraded;
      },
      stepOverrides: (state) => [
        { seq: 0, status: "done" }, { seq: 1, status: "done" }, { seq: 2, status: "done" },
        { seq: 3, status: "active", detail: {
          run_id: state.comparison_run_id,
          remaining_batches: Math.ceil((state.comparison_pending_source_item_ids?.length ?? 0) / COMPARISON_BATCH_SIZE)
            + (state.comparison_failed_source_item_ids?.length ?? 0),
        } },
        { seq: 4, status: "skipped" },
      ],
      onIllegal: "noop",
    });
    if (result.applied && result.state && !result.state.comparison_run_id
      && (result.state.comparison_pending_source_item_ids?.length ?? 0) === 0
      && (result.state.comparison_failed_source_item_ids?.length ?? 0) === 0) {
      await this.finalizeComparisonStage(input.spaceId, input.projectId, input.workflowId, input.operationId, null, input.userId);
    }
    return result;
  }

  /**
   * Writes the comparisons accumulated across every batch (once) and
   * transitions the operation out of "comparison". Reached either from
   * queueComparison (every remaining batch had zero eligible papers) or
   * reconcileCompletedComparison (the last batch just finished).
   */
  private async finalizeComparisonStage(
    spaceId: string,
    projectId: string,
    workflowId: string,
    operationId: string,
    finalizingRunId: string | null,
    instructedByUserId: string | null,
  ): Promise<void> {
    const row = await this.ports.operation(spaceId, operationId);
    if (!row) return;
    const state = researchState(row.progress_json);
    const comparisons = state.comparison_results_json ?? [];
    const runId = finalizingRunId ?? state.comparison_run_id ?? "";
    const notebookVersion = comparisons.length > 0 && runId
      ? (await new ProjectResearchMonitorComparisonService(this.db).persistComparisons({
        spaceId, projectId, workflowId, operationId, runId, comparisons,
      })).notebookVersion
      : null;
    await transition(this.db, spaceId, operationId, {
      from: ["comparison"],
      to: "complete",
      mutate: ({ state: current }) => {
        current.stage_state = comparisons.length > 0 ? "succeeded" : "skipped";
        current.monitoring_active = true;
        current.heartbeat_at = new Date().toISOString();
      },
      stepOverrides: [
        { seq: 0, status: "done" }, { seq: 1, status: "done" }, { seq: 2, status: "done" },
        comparisons.length > 0
          ? { seq: 3, status: "done", detail: { run_id: runId, notebook_version: notebookVersion, comparison_count: comparisons.length } }
          : { seq: 3, status: "skipped", detail: { reason: "No eligible papers to compare" } },
        { seq: 4, status: "skipped" },
      ],
    });
    const completed = await this.ports.operation(spaceId, operationId);
    if (completed?.status === "completed") {
      await this.ports.setWorkflowMonitoring(spaceId, projectId, workflowId, researchState(completed.progress_json));
      if (comparisons.length > 0) {
        await this.ports.enqueueIntegrityMonitor(spaceId, instructedByUserId, projectId, workflowId, "comparison_complete");
      }
    }
  }

  async reconcileComparisonStage(
    spaceId: string,
    operation: MonitoringOperationRow,
    state: ResearchOperationState,
  ): Promise<void> {
    const runId = state.comparison_run_id;
    if (!runId) {
      const actor = await this.ports.projectWriterActor(spaceId, operation.project_id);
      if (!actor) return this.ports.failOperation(operation, "Monitoring comparison requires a project writer");
      await this.queueComparison({
        spaceId,
        userId: actor,
        projectId: operation.project_id,
        operationId: operation.id,
        workflowId: state.workflow_id,
      });
      return;
    }
    const run = await this.db.query<{ status: string }>(
      `SELECT status FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, spaceId],
    );
    if (!run.rows[0]) return this.ports.failOperation(operation, "The monitoring comparison run no longer exists");
    if (["succeeded", "degraded", "failed", "cancelled"].includes(run.rows[0].status)) {
      await this.ports.reconcileCompletedRun(spaceId, runId);
      return;
    }
    await updateProjection(this.db, spaceId, operation.id, ({ state: current }) => {
      current.heartbeat_at = new Date().toISOString();
    });
  }

  async reconcileCompletedComparison(input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    operation: MonitoringOperationRow;
    runId: string;
    instructedByUserId: string | null;
    output: unknown;
    expectedSourceItemIds: string[];
  }): Promise<void> {
    try {
      // parseMonitorComparisons never throws for content problems — it
      // returns whatever subset of expectedSourceItemIds actually got a
      // valid, matching entry. Anything left over gets routed below rather
      // than discarding the whole batch or failing the operation over it.
      const matched: MonitorComparison[] = parseMonitorComparisons(input.output, input.expectedSourceItemIds);
      const matchedIds = new Set(matched.map((item) => item.source_item_id));
      const unmatched = input.expectedSourceItemIds.filter((id) => !matchedIds.has(id));
      const wasBatch = input.expectedSourceItemIds.length > 1;
      const updated = await updateProjection(this.db, input.spaceId, input.operation.id, ({ state }) => {
        if (state.comparison_run_id !== input.runId) return false;
        const existing = state.comparison_results_json ?? [];
        const bySourceItemId = new Map(existing.map((item) => [item.source_item_id, item]));
        for (const item of matched) bySourceItemId.set(item.source_item_id, item);
        state.comparison_results_json = [...bySourceItemId.values()];
        state.comparison_run_id = null;
        state.heartbeat_at = new Date().toISOString();
        if (wasBatch) {
          // A batch response left some papers unclassified — give each one
          // its own one-at-a-time retry instead of losing the rest of an
          // otherwise-good batch.
          if (unmatched.length > 0) {
            state.comparison_failed_source_item_ids = [...(state.comparison_failed_source_item_ids ?? []), ...unmatched];
          }
          // The model matched *nothing* in this batch — a stronger signal
          // than one bad entry that batching itself isn't working right now
          // (observed: a model fabricating comparisons for papers that were
          // never sent and don't exist). Drop to one-at-a-time for every
          // paper still left, not just this batch's leftovers.
          if (matched.length === 0) state.comparison_degraded = true;
        }
        // A solo (one-at-a-time) retry that still didn't match is simply
        // left without a stance — it is not requeued again, so a single
        // persistently uncooperative paper can never loop forever.
      });
      if (!updated.applied) return;
      const nothingLeft = (updated.state?.comparison_pending_source_item_ids?.length ?? 0) === 0
        && (updated.state?.comparison_failed_source_item_ids?.length ?? 0) === 0;
      if (nothingLeft) {
        await this.finalizeComparisonStage(
          input.spaceId, input.projectId, input.workflowId, input.operation.id, input.runId, input.instructedByUserId,
        );
      }
    } catch (error) {
      await this.ports.failOperation(
        input.operation,
        error instanceof Error ? error.message : "Monitoring comparison output is invalid",
      );
    }
  }

  private async markPostProcessingReconciled(spaceId: string, runId: string): Promise<void> {
    await this.db.query(
      `UPDATE source_post_processing_runs SET research_reconciled_at=$3 WHERE id=$1 AND space_id=$2`,
      [runId, spaceId, new Date().toISOString()],
    );
  }

  async recordScanSummary(
    operation: MonitoringOperation,
    state: ResearchOperationState,
    counts: ScanCounts,
  ): Promise<void> {
    // scannedAt is when this scan actually ran; watermark.after is the
    // publication-date cursor of the newest source item it picked up. These
    // can differ by months, so they must not be conflated.
    const scannedAt = new Date().toISOString();
    const scanSummaryId = await this.insertScanSummary({
      spaceId: operation.space_id,
      projectId: operation.project_id,
      workflowId: state.workflow_id,
      operationId: operation.id,
      scanKey: `operation:${operation.id}`,
      scanWindowStart: state.watermark.before ?? null,
      scanWindowEnd: state.watermark.after ?? scannedAt,
      scannedAt,
      newItemCount: state.source_item_ids.length,
      relevantCount: counts.relevant,
      maybeCount: counts.maybe,
      excludedCount: counts.excluded,
    });
    if (!scanSummaryId || !this.config || !state.query_strategy_id) return;
    const actor = await this.ports.projectWriterActor(operation.space_id, operation.project_id);
    if (!actor) return;
    const screeningProgress = objectValue(state.screening_progress);
    const screeningStartedAt = optionalString(screeningProgress.started_at);
    const screeningUpdatedAt = optionalString(screeningProgress.updated_at);
    const queueLatencyMs = screeningStartedAt && screeningUpdatedAt
      ? Math.max(0, Date.parse(screeningUpdatedAt) - Date.parse(screeningStartedAt))
      : null;
    try {
      await new ResearchMonitoringCoordinator(this.db, this.config).recordAndMaybePropose({
        identity: { spaceId: operation.space_id, userId: actor },
        projectId: operation.project_id,
        strategyId: state.query_strategy_id,
        scanSummaryId,
        observedAt: scannedAt,
        newCandidateCount: state.source_item_ids.length,
        relevantCount: counts.relevant,
        maybeCount: counts.maybe,
        excludedCount: counts.excluded,
        queueLatencyMs: Number.isFinite(queueLatencyMs) ? queueLatencyMs : null,
      });
    } catch (error) {
      process.stderr.write(`[project-research.monitoring-feedback] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  async insertScanSummary(input: ResearchScanSummaryInput): Promise<string | null> {
    const conflictAction = input.onConflict === "refresh_scan_time"
      ? "DO UPDATE SET scanned_at = EXCLUDED.scanned_at, scan_window_end = EXCLUDED.scan_window_end"
      : "DO NOTHING";
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,operation_id,scan_key,scan_window_start,scan_window_end,
         scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (space_id,workflow_id,scan_key) ${conflictAction}
       RETURNING id`,
      [randomUUID(), input.spaceId, input.projectId, input.workflowId, input.operationId, input.scanKey,
        input.scanWindowStart, input.scanWindowEnd, input.scannedAt, input.newItemCount,
        input.relevantCount, input.maybeCount, input.excludedCount, new Date().toISOString()],
    );
    if (inserted.rows[0]?.id) return inserted.rows[0].id;
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM research_scan_summaries
        WHERE space_id=$1 AND workflow_id=$2 AND scan_key=$3`,
      [input.spaceId, input.workflowId, input.scanKey],
    );
    return existing.rows[0]?.id ?? null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
