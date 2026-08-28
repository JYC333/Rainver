import { isDeepStrictEqual } from "node:util";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError, objectValue, optionalString, withQueryableTransaction } from "../routeUtils/common.js";
import { ProjectOperationService } from "../projects/projectOperationService.js";

/**
 * Durable Project Research operation projection and persistence helpers.
 *
 * WorkflowExecution is the sole orchestration authority. This module only
 * persists its domain projection (`project_operations.progress_json`, derived
 * steps, and `project_research_workflows.current_stage`) under the operation
 * row lock. It does not define or execute a second workflow graph.
 *
 * - `advanceOperation` — applies a pass outcome and optionally moves the
 *   projected stage. One
 *   transaction: `SELECT … FOR UPDATE` on the operation row, re-read state,
 *   reject/no-op when the current stage is not in `from`, apply the mutation,
 *   derive operation status, step states and the workflow stage from the new
 *   stage, write once.
 * - `refreshOperation` — same lock; refreshes read-model fields
 *   (heartbeat, `*_progress`) without changing the stage or status.
 *
 * The caller supplies its expected source stages as an optimistic concurrency
 * condition. There is deliberately no global legal-transition table here:
 * WorkflowExecution definitions and their immutable node graphs own control
 * flow.
 */

export type ResearchStage =
  | "monitor_setup"
  | "backfill"
  | "screening"
  | "comparison"
  | "synthesis"
  | "idea_review"
  | "complete"
  | "failed";

const RESEARCH_STAGES: readonly ResearchStage[] = [
  "monitor_setup",
  "backfill",
  "screening",
  "comparison",
  "synthesis",
  "idea_review",
  "complete",
  "failed",
];

export type ResearchOperationStatus = "draft" | "active" | "waiting_review" | "completed" | "failed" | "cancelled";

export type ResearchStepStatus = "pending" | "active" | "blocked" | "done" | "skipped";

export type RunKind = "baseline" | "historical_backfill" | "incremental" | "question_rescreen" | "synthesis_only";
export type HistoryMode = "bounded_range" | "all_available";
export type ResearchReportDepth = "quick" | "full";
export type OperationStageState = "pending" | "running" | "waiting_review" | "succeeded" | "failed" | "skipped";

export interface ResearchOperationError {
  code: string;
  message: string;
  at: string;
  diagnostics?: Record<string, unknown>;
}

export interface ResearchOperationState {
  schema_version: "project_research_operation.v1";
  run_kind: RunKind;
  workflow_id: string;
  query_strategy_id?: string | null;
  research_question: string;
  research_question_version: number;
  thread_scope: Array<{
    thread_id: string;
    version: number;
    kind: "question";
    statement: string;
  }>;
  research_scope: {
    sub_questions: string[];
    in: string[];
    out: string[];
    must_have: string[];
    nice_to_have: string[];
  };
  report_depth: ResearchReportDepth;
  question_refine_skipped: boolean;
  channel_ids: string[];
  project_source_binding_ids: string[];
  source_post_processing_rule_ids: string[];
  project_source_binding_id: string | null;
  source_post_processing_rule_id: string | null;
  source_backfill_plan_id: string | null;
  source_backfill_plan_ids: string[];
  query: {
    source_channel_ids: string[];
    fingerprint: string;
    sort_by: string;
    history_mode: HistoryMode | null;
    from: string | null;
    to: string | null;
  };
  history: { mode: HistoryMode | null; from: string | null; to: string | null; max_items: number | null };
  coverage_ranges?: Array<{ from: string; to: string; operation_id: string; status: "pending" | "completed" | "partial" }>;
  watermark: { before: string | null; after: string | null; overlap_hours: number };
  source_item_ids: string[];
  current_stage: ResearchStage;
  stage_state: OperationStageState;
  agent_id: string;
  runtime_profile_id: string;
  checkpoint_ids: string[];
  synthesis_run_id: string | null;
  comparison_run_id?: string | null;
  comparison_source_item_ids?: string[];
  // Material not yet submitted in a comparison batch. Comparing many items in
  // one structured-output call is unreliable (models drop, duplicate, or
  // invent source_item_ids), so each batch covers only
  // comparison_source_item_ids (BATCH_SIZE items, or 1 once degraded); this
  // holds the rest until their own batch runs.
  comparison_pending_source_item_ids?: string[];
  // Material a batch response didn't produce a valid, matching entry for.
  // Retried one at a time (never re-batched) once the pending pool is
  // empty, so one bad item in an otherwise-good batch doesn't cost the
  // whole batch a retry. An id that still has no valid entry after its
  // solo retry is simply left without a stance — it is not requeued again.
  comparison_failed_source_item_ids?: string[];
  // Set once a single batch response matches none of the items sent to it
  // (see MonitorComparison — a stronger signal than one bad entry that
  // batching itself isn't working right now, e.g. a model returning
  // fabricated content unrelated to any item actually sent). From then on,
  // every remaining item for this operation — pending or failed — is sent
  // one at a time instead of batched.
  comparison_degraded?: boolean;
  // The notebook role the comparison needs a note in and this project has
  // none for (N2 — normally `understanding`). Set when the stage stops for
  // want of a baseline rather than for want of material, and cleared as soon as
  // a batch queues, so "no comparison happened" always carries its reason
  // instead of looking like an empty scan.
  comparison_missing_baseline_role?: string;
  // Batches already validated, accumulated here until the pending and
  // failed pools are both empty and they are persisted together in one write.
  comparison_results_json?: Array<{
    source_item_id: string;
    stance: "supports" | "contradicts" | "new_direction";
    detail: string;
    affected_sections: Array<"understanding" | "questions" | "ideas" | "experiments">;
  }>;
  synthesis_critique?: {
    status: "needs_queue" | "queued" | "revision_needed" | "completed";
    run_id: string | null;
    report_run_id: string;
    archive_artifact_id: string;
    round: number;
    revision_count: number;
    verdict?: "pass" | "revise";
    issues: Array<{
      severity: "critical" | "major" | "minor";
      kind: "cherry_picking" | "missing_contradiction" | "unsupported_claim" | "alternative_explanation" | "overreach";
      detail: string;
      affected_refs: string[];
    }>;
    all_issues: Array<{
      severity: "critical" | "major" | "minor";
      kind: "cherry_picking" | "missing_contradiction" | "unsupported_claim" | "alternative_explanation" | "overreach";
      detail: string;
      affected_refs: string[];
    }>;
    artifact_ids: string[];
  };
  artifact_ids: string[];
  matrix_artifact_id?: string;
  failed_stage?: string;
  partial: boolean;
  coverage_degraded?: boolean;
  monitoring_active: boolean;
  awaiting_source_scan?: boolean;
  pending_incremental_source_item_ids?: string[];
  /** How many scanned items this update deferred to the next one because it
   *  reached its own screening budget. Recorded so a monitor that is falling
   *  behind is visible rather than silently growing a backlog. */
  deferred_incremental_items?: number;
  post_processing_recovery_requested_at?: string;
  empty_result?: {
    kind: "no_source_items" | "no_relevant_sources" | "no_coherent_synthesis";
    source_item_count: number;
    relevant_source_count?: number;
    detected_at: string;
    message: string;
    reason_code?: string;
    suggestions?: string[];
  };
  screening_progress?: {
    phase: "preparing_batches" | "screening_batches" | "ready_for_review" | "completed" | "failed";
    total_items: number;
    classified_items: number;
    unclassified_items: number;
    relevant_items: number;
    maybe_items: number;
    excluded_items: number;
    missing_full_text: number;
    evidence_count: number;
    failed_items: number;
    batch_size: number;
    total_batches: number;
    completed_batches: number;
    active_batches: number;
    queued_batches: number;
    running_batches: number;
    failed_batches: number;
    started_at: string | null;
    updated_at: string;
    message: string;
  };
  // Last classification count observed while screening was still incomplete,
  // and when it was first observed at that value. `screening_progress
  // .updated_at` is recomputed on every tick, so it cannot say whether
  // anything actually moved; this can. Used only to tell a slow screening
  // from a stuck one — see `ProjectResearchScreeningCoordinator.createGate`.
  screening_stall_watch?: { classified_items: number; since: string };
  synthesis_progress?: {
    run_id: string;
    run_status: string;
    job_id?: string | null;
    job_status?: string | null;
    job_attempts?: number | null;
    job_heartbeat_at?: string | null;
    job_updated_at?: string | null;
    run_updated_at?: string | null;
    last_event_at?: string | null;
    last_event_type?: string | null;
    queued_at: string | null;
    started_at: string | null;
    updated_at: string;
    message: string;
  };
  error?: ResearchOperationError;
  backfill_progress?: {
    total_segments: number;
    completed_segments: number;
    failed_segments: number;
    deferred_segments?: number;
    running_segments: number;
    pending_segments: number;
    items_ingested: number;
    next_retry_at?: string | null;
    deferred_sources?: Array<{
      provider_key: string | null;
      provider_display_name: string | null;
      upstream_status: number | null;
      automatic_attempts: number;
      next_retry_at: string | null;
    }>;
    plans: Array<{
      id: string;
      status: string;
      segments_total: number;
      segments_completed: number;
      segments_failed: number;
      items_ingested: number;
      updated_at: string | null;
    }>;
    updated_at: string;
  };
  heartbeat_at?: string;
  idempotency: { key: string; fingerprint: string };
}

export interface ResearchOperationRow {
  id: string;
  space_id: string;
  project_id: string;
  kind?: string;
  status: string;
  progress_json: unknown;
  version: number;
  created_at?: string;
}

export interface ResearchMutationSpec {
  /** Stages the operation must currently be in for the projection mutation to apply. */
  from: readonly ResearchStage[];
  to: ResearchStage;
  /**
   * Applied to the freshly re-read state while the row lock is held. May use
   * the transaction for reads/auxiliary writes. Return `false` to abort
   * without writing (treated as a no-op, `applied: false`).
   */
  mutate?: (ctx: { db: Queryable; row: ResearchOperationRow; state: ResearchOperationState }) => void | boolean | Promise<void | boolean>;
  /**
   * Per-step status/detail annotations applied on top of the derived states.
   * A factory form is evaluated after `mutate`, so it can annotate with values
   * the mutation produced (run ids, checkpoint ids, counts).
   */
  stepOverrides?: ResearchStepOverride[] | ((state: ResearchOperationState) => ResearchStepOverride[]);
  /**
   * Stale-stage behavior: reconciler/event paths no-op (default) so a
   * stale observation converges instead of clobbering; user-action paths
   * throw so caller bugs surface as 409s.
   */
  onStale?: "noop" | "throw";
}

export interface ResearchStepOverride {
  seq: number;
  status?: ResearchStepStatus;
  detail?: Record<string, unknown>;
}

export interface ResearchMutationResult {
  applied: boolean;
  reason?: "not_found" | "terminal_status" | "stale_stage" | "aborted";
  row?: ResearchOperationRow;
  state?: ResearchOperationState;
}

const ACTIVE_RESEARCH_OPERATION_INDEX = "uq_project_operations_active_research_workflow";

export async function advanceOperation(
  db: Queryable,
  spaceId: string,
  operationId: string,
  spec: ResearchMutationSpec,
): Promise<ResearchMutationResult> {
  return withQueryableTransaction(db, async (tx) => {
    const row = await lockOperationRow(tx, spaceId, operationId);
    if (!row) return { applied: false, reason: "not_found" as const };
    if (row.status === "cancelled") {
      if (spec.onStale === "throw") {
        throw new HttpError(409, `Research operation ${row.id} is cancelled`);
      }
      return { applied: false, reason: "terminal_status" as const, row };
    }
    const state = researchState(row.progress_json);
    const current = researchStage(state.current_stage);
    if (!spec.from.includes(current)) {
      return staleMutation(spec, row, `expected one of ${spec.from.join(", ")}, found ${current}`);
    }

    const previousStageState = state.stage_state;
    if (spec.mutate && (await spec.mutate({ db: tx, row, state })) === false) {
      return { applied: false, reason: "aborted" as const, row, state };
    }
    state.current_stage = spec.to;
    if (spec.to !== current && state.stage_state === previousStageState) {
      state.stage_state = spec.to === "failed" ? "failed" : spec.to === "complete" ? "succeeded" : "running";
    }

    const status = deriveOperationStatus(state);
    const steps = applyStepOverrides(deriveStepStates(state), spec.stepOverrides, state);
    await writeOperationState(tx, row, status, state, steps);
    await syncWorkflowStage(tx, row, state);
    return { applied: true, row: { ...row, status }, state };
  });
}

export async function refreshOperation(
  db: Queryable,
  spaceId: string,
  operationId: string,
  mutate: (ctx: { db: Queryable; row: ResearchOperationRow; state: ResearchOperationState }) => void | boolean | Promise<void | boolean>,
  stepOverrides?: ResearchStepOverride[] | ((state: ResearchOperationState) => ResearchStepOverride[]),
): Promise<ResearchMutationResult> {
  return withQueryableTransaction(db, async (tx) => {
    const row = await lockOperationRow(tx, spaceId, operationId);
    if (!row) return { applied: false, reason: "not_found" as const };
    if (row.status === "cancelled") {
      return { applied: false, reason: "terminal_status" as const, row };
    }
    const state = researchState(row.progress_json);
    const stageBefore = state.current_stage;
    if ((await mutate({ db: tx, row, state })) === false) {
      return { applied: false, reason: "aborted" as const, row, state };
    }
    if (state.current_stage !== stageBefore) {
      throw new Error(
        `refreshOperation must not change current_stage (${stageBefore} -> ${state.current_stage}); use advanceOperation`,
      );
    }
    const status = deriveOperationStatus(state);
    await syncWorkflowStage(tx, row, state);
    await writeOperationState(tx, row, status, state, applyStepOverrides(deriveStepStates(state), stepOverrides, state));
    return { applied: true, row: { ...row, status }, state };
  });
}

function staleMutation(
  spec: ResearchMutationSpec,
  row: ResearchOperationRow,
  detail: string,
): ResearchMutationResult {
  if (spec.onStale === "throw") {
    throw new HttpError(409, `Research operation ${row.id} cannot move to ${spec.to}: ${detail}`);
  }
  process.stderr.write(
    `[project-research.projection] skipped stale mutation to ${spec.to} for operation ${row.id}: ${detail}\n`,
  );
  return { applied: false, reason: "stale_stage", row };
}

async function lockOperationRow(tx: Queryable, spaceId: string, operationId: string): Promise<ResearchOperationRow | null> {
  const owner = await tx.query<{ project_id: string }>(
    `SELECT project_id FROM project_operations
      WHERE id=$1 AND space_id=$2 AND kind='research'`,
    [operationId, spaceId],
  );
  if (!owner.rows[0]) return null;
  const project = await tx.query<{ status: string }>(
    `SELECT status FROM projects
      WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL
      FOR UPDATE`,
    [owner.rows[0].project_id, spaceId],
  );
  if (project.rows[0]?.status !== "active") return null;
  const result = await tx.query<ResearchOperationRow>(
    `SELECT id, space_id, project_id, kind, status, progress_json, version, created_at
       FROM project_operations WHERE id=$1 AND space_id=$2 AND kind='research' FOR UPDATE`,
    [operationId, spaceId],
  );
  return result.rows[0] ?? null;
}

async function writeOperationState(
  tx: Queryable,
  row: ResearchOperationRow,
  status: ResearchOperationStatus,
  state: ResearchOperationState,
  steps: Array<{ seq: number; status: ResearchStepStatus; detail?: Record<string, unknown> }>,
): Promise<void> {
  try {
    await new ProjectOperationService(tx).setManagedState(row.space_id, row.project_id, row.id, {
      status,
      progress: state as unknown as Record<string, unknown>,
      stepStates: steps,
      replaceProgress: true,
      expectedVersion: row.version,
    });
  } catch (error) {
    if (isUniqueViolation(error, ACTIVE_RESEARCH_OPERATION_INDEX)) {
      throw new HttpError(409, "Another Project Research operation is already active for this workflow");
    }
    throw error;
  }
}

/**
 * The workflow's current_stage is a projection of the driving operation's
 * stage, derived here and nowhere else. Failure keeps the workflow stage in
 * place (the operation carries the error); completion hands the workflow to
 * monitoring when the operation activated it.
 */
async function syncWorkflowStage(tx: Queryable, row: ResearchOperationRow, state: ResearchOperationState): Promise<void> {
  if (!state.workflow_id) return;
  const stage = state.current_stage === "complete"
    ? (state.monitoring_active ? "monitoring" : null)
    : ["backfill", "screening", "comparison", "synthesis", "idea_review"].includes(state.current_stage)
      ? state.current_stage
      : null;
  if (!stage) return;
  const now = new Date().toISOString();
  await tx.query(
    `WITH changed AS (UPDATE project_research_workflows SET current_stage=$4
      WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
     UPDATE space_objects object SET updated_at=$5 FROM changed
      WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
    [row.space_id, row.project_id, state.workflow_id, stage, now],
  );
}

function deriveOperationStatus(state: ResearchOperationState): ResearchOperationStatus {
  if (state.current_stage === "failed") return "failed";
  if (state.current_stage === "complete") return "completed";
  return state.stage_state === "waiting_review" ? "waiting_review" : "active";
}

export function researchState(value: unknown): ResearchOperationState {
  const source = JSON.parse(JSON.stringify(objectValue(value))) as Record<string, unknown>;
  const query = objectValue(source.query);
  const history = objectValue(source.history);
  const watermark = objectValue(source.watermark);
  const idempotency = objectValue(source.idempotency);
  const stageState = optionalString(source.stage_state);
  const historyMode = optionalString(history.mode);
  const queryHistoryMode = optionalString(query.history_mode);
  const projectSourceBindingId = optionalString(source.project_source_binding_id);
  const sourcePostProcessingRuleId = optionalString(source.source_post_processing_rule_id);
  const sourceBackfillPlanId = optionalString(source.source_backfill_plan_id);
  const projectSourceBindingIds = stringArray(source.project_source_binding_ids);
  const sourcePostProcessingRuleIds = stringArray(source.source_post_processing_rule_ids);
  const sourceBackfillPlanIds = stringArray(source.source_backfill_plan_ids);
  const synthesisRunId = optionalString(source.synthesis_run_id);
  const researchScope = objectValue(source.research_scope);
  return {
    ...source,
    schema_version: "project_research_operation.v1",
    run_kind: ["baseline", "historical_backfill", "incremental", "question_rescreen", "synthesis_only"].includes(String(source.run_kind))
      ? source.run_kind
      : "baseline",
    workflow_id: optionalString(source.workflow_id) ?? "",
    query_strategy_id: optionalString(source.query_strategy_id),
    research_question: optionalString(source.research_question) ?? "",
    research_question_version: typeof source.research_question_version === "number" && Number.isInteger(source.research_question_version)
      ? source.research_question_version
      : 1,
    thread_scope: Array.isArray(source.thread_scope)
      ? source.thread_scope.flatMap((item) => {
        const row = objectValue(item);
        const threadId = optionalString(row.thread_id);
        const statement = optionalString(row.statement);
        const version = row.version;
        return threadId && statement && typeof version === "number" && Number.isInteger(version) && version >= 1
          ? [{ thread_id: threadId, version, kind: "question" as const, statement }]
          : [];
      })
      : [],
    research_scope: {
      sub_questions: stringArray(researchScope.sub_questions),
      in: stringArray(researchScope.in),
      out: stringArray(researchScope.out),
      must_have: stringArray(researchScope.must_have),
      nice_to_have: stringArray(researchScope.nice_to_have),
    },
    report_depth: source.report_depth === "quick" ? "quick" : "full",
    question_refine_skipped: source.question_refine_skipped === true,
    channel_ids: stringArray(source.channel_ids),
    project_source_binding_ids: projectSourceBindingIds,
    source_post_processing_rule_ids: sourcePostProcessingRuleIds,
    project_source_binding_id: projectSourceBindingId,
    source_post_processing_rule_id: sourcePostProcessingRuleId,
    source_backfill_plan_id: sourceBackfillPlanId,
    source_backfill_plan_ids: sourceBackfillPlanIds.length > 0
      ? sourceBackfillPlanIds
      : sourceBackfillPlanId ? [sourceBackfillPlanId] : [],
    query: {
      source_channel_ids: stringArray(query.source_channel_ids),
      fingerprint: optionalString(query.fingerprint) ?? "",
      sort_by: optionalString(query.sort_by) ?? "submittedDate",
      history_mode: queryHistoryMode === "bounded_range" || queryHistoryMode === "all_available" ? queryHistoryMode : null,
      from: optionalString(query.from),
      to: optionalString(query.to),
    },
    history: {
      mode: historyMode === "bounded_range" || historyMode === "all_available" ? historyMode : null,
      from: optionalString(history.from),
      to: optionalString(history.to),
      max_items: typeof history.max_items === "number" && Number.isInteger(history.max_items) ? history.max_items : null,
    },
    watermark: {
      before: optionalString(watermark.before),
      after: optionalString(watermark.after),
      overlap_hours: typeof watermark.overlap_hours === "number" && Number.isFinite(watermark.overlap_hours)
        ? watermark.overlap_hours
        : 48,
    },
    source_item_ids: stringArray(source.source_item_ids),
    current_stage: researchStage(source.current_stage),
    stage_state: ["pending", "running", "waiting_review", "succeeded", "failed", "skipped"].includes(stageState ?? "")
      ? stageState
      : "pending",
    agent_id: optionalString(source.agent_id) ?? "",
    runtime_profile_id: optionalString(source.runtime_profile_id) ?? "",
    checkpoint_ids: stringArray(source.checkpoint_ids),
    synthesis_run_id: synthesisRunId,
    comparison_run_id: optionalString(source.comparison_run_id),
    comparison_source_item_ids: stringArray(source.comparison_source_item_ids),
    artifact_ids: stringArray(source.artifact_ids),
    partial: source.partial === true,
    coverage_degraded: source.coverage_degraded === true,
    monitoring_active: source.monitoring_active === true,
    idempotency: {
      key: optionalString(idempotency.key) ?? "",
      fingerprint: optionalString(idempotency.fingerprint) ?? "",
    },
  } as ResearchOperationState;
}

export function researchStage(value: unknown): ResearchStage {
  return RESEARCH_STAGES.includes(value as ResearchStage) ? (value as ResearchStage) : "monitor_setup";
}

export function operationSteps(): string[] {
  return ["Resolve source monitors", "Import history or scan delta", "Review screening", "Compare or synthesize evidence", "Review idea candidates"];
}

export function researchStageIndex(value: unknown): number {
  return value === "monitor_setup" ? 0
    : value === "backfill" ? 1
      : value === "screening" ? 2
        : value === "comparison" || value === "synthesis" ? 3
          : value === "idea_review" ? 4
            : value === "complete" ? 5
              : 4;
}

export function deriveStepStates(state: ResearchOperationState): Array<{ seq: number; status: ResearchStepStatus }> {
  const stage = state.current_stage === "failed" ? (state.failed_stage ?? "idea_review") : state.current_stage;
  const index = researchStageIndex(stage);
  const blocked = state.current_stage === "failed" || state.stage_state === "waiting_review" || state.stage_state === "failed";
  return operationSteps().map((_, seq) => ({
    seq,
    status: seq < index ? "done" as const : seq === index ? (blocked ? "blocked" as const : "active" as const) : "pending" as const,
  }));
}

export function deriveSkippedAfterScreeningSteps(): ResearchStepOverride[] {
  return operationSteps().map((_, seq) => ({ seq, status: seq < 2 ? "done" as const : "skipped" as const }));
}

/**
 * Applies a stale orchestrator snapshot to the freshly locked state while
 * preserving fields changed by another reconciler since that snapshot was
 * read. Source item ids are append-only for research operations, so concurrent
 * observations are unioned instead of allowing one observation to erase the
 * other.
 */
export function applyResearchStatePatch(
  current: ResearchOperationState,
  base: ResearchOperationState,
  proposed: ResearchOperationState,
): void {
  const currentRecord = current as unknown as Record<string, unknown>;
  const baseRecord = base as unknown as Record<string, unknown>;
  const proposedRecord = proposed as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(proposedRecord)]);
  for (const key of keys) {
    const baseHas = Object.prototype.hasOwnProperty.call(baseRecord, key);
    const proposedHas = Object.prototype.hasOwnProperty.call(proposedRecord, key);
    if (!proposedHas) {
      if (baseHas) delete currentRecord[key];
      continue;
    }
    if (!baseHas || !isDeepStrictEqual(baseRecord[key], proposedRecord[key])) {
      if (key === "source_item_ids" && Array.isArray(currentRecord[key]) && Array.isArray(proposedRecord[key])) {
        currentRecord[key] = stringArray([...(currentRecord[key] as unknown[]), ...(proposedRecord[key] as unknown[])]);
      } else {
        currentRecord[key] = proposedRecord[key];
      }
    }
  }
}

function applyStepOverrides(
  steps: Array<{ seq: number; status: ResearchStepStatus }>,
  overrides: ResearchMutationSpec["stepOverrides"],
  state: ResearchOperationState,
): Array<{ seq: number; status: ResearchStepStatus; detail?: Record<string, unknown> }> {
  const values = typeof overrides === "function" ? overrides(state) : overrides;
  if (!values?.length) return steps;
  const bySeq = new Map(values.map((override) => [override.seq, override]));
  return steps.map((step) => {
    const override = bySeq.get(step.seq);
    if (!override) return step;
    return { seq: step.seq, status: override.status ?? step.status, ...(override.detail ? { detail: override.detail } : {}) };
  });
}

function isUniqueViolation(error: unknown, indexName: string): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return Boolean(value && value.code === "23505" && value.constraint === indexName);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
    : [];
}
