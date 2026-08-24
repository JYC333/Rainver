import type { Queryable } from "../../routeUtils/common";
import { objectValue, optionalString } from "../../routeUtils/common";
import { SOURCE_POST_PROCESSING_LIMITS } from "../../sources/postProcessing/config";
import {
  SCREENING_AUTO_CONTINUE_CORPUS_LIMIT,
  checkpointBlocks,
  screeningExceedsAutoBudget,
  waiveCheckpointAutomatically,
} from "../researchCheckpointPolicy";
import {
  applyResearchStatePatch,
  deriveSkippedAfterScreeningSteps,
  researchStage,
  researchState,
  advanceOperation as advanceResearchOperation,
  type ResearchOperationState,
  type ResearchStepOverride,
} from "../operationProjection";

export interface ScreeningOperationRow {
  id: string;
  space_id: string;
  project_id: string;
  progress_json: unknown;
  created_at?: string;
}

export interface ScreeningCounts {
  total: number;
  relevant: number;
  maybe: number;
  excluded: number;
  missing_full_text: number;
  evidence_count: number;
  failed_items: number;
}

export interface ProjectResearchScreeningPorts {
  createCheckpoint(
    spaceId: string,
    projectId: string,
    workflowId: string,
    operationId: string,
    type: string,
    result: Record<string, unknown>,
  ): Promise<string>;
  setState(
    operation: ScreeningOperationRow,
    state: ResearchOperationState,
    steps: ResearchStepOverride[],
  ): Promise<void>;
  /** Continues past a checkpoint the reform waived, on the same path a human
   * approval takes — see `createGate`. */
  resumeAfterCheckpoint(
    operation: ScreeningOperationRow,
    workflowId: string,
    checkpointId: string,
  ): Promise<void>;
  /** Reports a research Operation's state to its originating Room, if it has
   * one. Inert for an Operation with no Room origin. */
  notifyRoom(
    operation: ScreeningOperationRow,
    status: "waiting_review" | "completed",
    reason: string,
  ): Promise<void>;
  /** Fails the Operation through the orchestrator's single failure path, which
   * also owns the `failed` Room notification. */
  failOperation(operation: ScreeningOperationRow, message: string): Promise<void>;
}

/**
 * How long classification may sit at the same count, with nothing in flight,
 * before the operation is called stuck rather than slow.
 *
 * Deliberately generous: a false positive fails a recoverable operation
 * (retryable, and the user is told), while a false negative is the hang this
 * exists to end. On the incremental path classification is driven by the
 * source pipeline's own cadence, so short windows would misread a quiet
 * source as a stall.
 */
const SCREENING_STALL_WINDOW_MS = 60 * 60_000;

/** The screening stage's five-step projection. seq 0/1 are always behind us
 * here and seq 4 is always ahead; only the screening step itself (seq 2) and
 * whether synthesis (seq 3) has started vary between `createGate`'s exits. */
function screeningGateSteps(
  seq2: { status: "active" | "blocked" | "done"; detail: Record<string, unknown> },
  seq3Status: "pending" | "active",
): ResearchStepOverride[] {
  return [
    { seq: 0, status: "done" },
    { seq: 1, status: "done" },
    { seq: 2, status: seq2.status, detail: seq2.detail },
    { seq: 3, status: seq3Status },
    { seq: 4, status: "pending" },
  ];
}

/** Owns screening progress, corpus counts, the review gate, and valid empty
 * intake completion. Source post-processing remains the classification owner. */
export class ProjectResearchScreeningCoordinator {
  constructor(
    private readonly db: Queryable,
    private readonly ports: ProjectResearchScreeningPorts,
  ) {}

  async createGate(operation: ScreeningOperationRow, state: ResearchOperationState): Promise<void> {
    const counts = await this.countRelevantItems(operation.space_id, operation.project_id, state.source_item_ids);
    const checkpointId = await this.ports.createCheckpoint(
      operation.space_id,
      operation.project_id,
      state.workflow_id,
      operation.id,
      "screening_gate",
      {
        operation_id: operation.id,
        run_kind: state.run_kind,
        total: state.source_item_ids.length,
        relevant: counts.relevant,
        maybe: counts.maybe,
        excluded: counts.excluded,
        missing_full_text: counts.missing_full_text,
        evidence_count: counts.evidence_count,
        failed_items: counts.failed_items,
        partial: state.partial,
        coverage_degraded: state.coverage_degraded === true,
        deferred_sources: state.backfill_progress?.deferred_sources ?? [],
      },
    );
    if (!state.checkpoint_ids.includes(checkpointId)) state.checkpoint_ids.push(checkpointId);
    // Captured before this method mutates the state: `waiting_review` here
    // means a previous tick already paused (and already told the Room), so
    // this tick only refreshes the checkpoint snapshot.
    const wasAlreadyPaused = researchState(operation.progress_json).stage_state === "waiting_review";
    state.current_stage = "screening";
    state.heartbeat_at = new Date().toISOString();

    // The gate did two jobs, and only one of them was asking a human.
    //
    // On the incremental path there is no drain check before this point (the
    // baseline path has `ensureItemsProcessed`), so the checkpoint opens while
    // classification is still running and each later reconcile tick refreshes
    // its snapshot in place. What actually released the operation was the
    // human approving *after* watching the count reach completion. Waiving on
    // the first tick would therefore send a partly-classified corpus to
    // synthesis, and freeze the checkpoint's snapshot at that moment, since
    // `upsertPendingResearchCheckpoint` only refreshes rows still pending.
    //
    // So auto-continue waits for classification, which is a machine condition
    // and needs no human. Until then the checkpoint stays a live pending
    // record exactly as before — and a human approving that pending gate from
    // the web UI remains the manual override for a classification that will
    // never finish (approval bypasses this wait by design).
    const progress = state.screening_progress;
    const classificationComplete = !progress
      || (progress.total_items > 0 && progress.classified_items >= progress.total_items);

    if (!classificationComplete) {
      // Classification that will never finish has to end as a failure, or the
      // operation shows "running" forever with no lever: `failed` is the only
      // status `retryFailedOperation` accepts, and `failOperation` posts the
      // Room notification. There are two ways it never finishes.
      //
      // The visible one is a batch that exhausted its retries.
      if ((progress?.failed_batches ?? 0) > 0) {
        await this.ports.failOperation(
          operation,
          `Screening stalled: ${progress?.failed_batches} classification batch(es) failed permanently, so ${progress?.unclassified_items ?? 0} item(s) were never classified.`,
        );
        return;
      }

      // The silent one has no failed batch to point at — the incremental path
      // enqueues no recovery batches at all (`ensureItemsProcessed` runs only
      // for baseline and question_rescreen), so items left unclassified at the
      // current research-question version simply never get a decision and
      // every counter reads zero. What distinguishes that from a slow
      // screening is only whether the count moves, so that is what is
      // measured. Work still in flight is never called stuck, however long it
      // takes.
      const observed = progress?.classified_items ?? 0;
      const inFlight = (progress?.active_batches ?? 0) > 0;
      const watch = state.screening_stall_watch;
      if (inFlight || !watch || watch.classified_items !== observed) {
        state.screening_stall_watch = { classified_items: observed, since: new Date().toISOString() };
      } else if (Date.now() - new Date(watch.since).getTime() > SCREENING_STALL_WINDOW_MS) {
        await this.ports.failOperation(
          operation,
          `Screening stalled: ${progress?.unclassified_items ?? 0} of ${progress?.total_items ?? 0} item(s) have gone unclassified with no progress for over ${Math.round(SCREENING_STALL_WINDOW_MS / 60_000)} minutes and no classification work in flight.`,
        );
        return;
      }

      state.stage_state = "running";
      await this.ports.setState(operation, state, screeningGateSteps(
        { status: "active", detail: { checkpoint_id: checkpointId, counts } },
        "pending",
      ));
      return;
    }

    // Classification finished; the stall watch has nothing left to watch.
    delete state.screening_stall_watch;

    if (checkpointBlocks("screening_gate") || screeningExceedsAutoBudget(counts)) {
      state.stage_state = "waiting_review";
      await this.ports.setState(operation, state, screeningGateSteps(
        { status: "blocked", detail: { checkpoint_id: checkpointId, counts } },
        "pending",
      ));
      // Only the tick that pauses speaks; later ticks just refresh the
      // snapshot. Without this edge check the nudger would enqueue a notify
      // job every few seconds for the whole wait.
      if (!wasAlreadyPaused) {
        await this.ports.notifyRoom(
          operation,
          "waiting_review",
          `Screening matched ${counts.relevant + counts.maybe} items, over the ${SCREENING_AUTO_CONTINUE_CORPUS_LIMIT}-item limit for continuing without review. Approving the screening checkpoint (on the Project's Operations page) synthesizes anyway; the operation can also be cancelled from here.`,
        );
      }
      return;
    }

    // Non-blocking: record what the machine concluded, then continue on the
    // exact path a human approval took. Reusing `resumeAfterCheckpoint`
    // rather than inlining the advance keeps one implementation of "what
    // happens after screening" — the alternative drifts the moment either
    // copy is fixed.
    //
    // Order matters: persist, then waive. A stage-advancing `setState` is
    // `onStale: "noop"`, so a lost race drops the write silently — and once
    // the checkpoint is waived, `screeningGateDecided` treats screening as
    // behind us and never re-enters this transition, stranding the operation
    // in a state with no `failed` status to retry from. Waiving only after
    // the state landed means a dropped write just replays next tick.
    state.stage_state = "running";
    await this.ports.setState(operation, state, screeningGateSteps(
      { status: "done", detail: { checkpoint_id: checkpointId, counts, auto_continued: true } },
      "active",
    ));
    await waiveCheckpointAutomatically(
      this.db,
      operation.space_id,
      checkpointId,
      `Screening matched ${counts.relevant + counts.maybe} items, within the ${SCREENING_AUTO_CONTINUE_CORPUS_LIMIT}-item limit for continuing without review.`,
    );
    await this.ports.resumeAfterCheckpoint(operation, state.workflow_id, checkpointId);
  }

  async completeEmptyInitialIntake(operation: ScreeningOperationRow, state: ResearchOperationState): Promise<void> {
    const base = researchState(operation.progress_json);
    const now = new Date().toISOString();
    state.empty_result = {
      kind: "no_source_items",
      source_item_count: 0,
      detected_at: now,
      message: "Search completed, but no material matched the selected source and history window.",
    };
    state.current_stage = "complete";
    state.stage_state = "skipped";
    state.monitoring_active = false;
    state.screening_progress = {
      ...(state.screening_progress ?? await this.progressFor(
        operation.space_id,
        operation.project_id,
        operation.id,
        state,
        operation.created_at,
      )),
      phase: "completed",
      total_items: 0,
      classified_items: 0,
      unclassified_items: 0,
      message: state.empty_result.message,
      updated_at: now,
    };
    await advanceResearchOperation(this.db, operation.space_id, operation.id, {
      from: [researchStage(base.current_stage)],
      to: "complete",
      mutate: async ({ db, state: current }) => {
        applyResearchStatePatch(current, base, state);
        await db.query(
          `UPDATE project_research_checkpoints
              SET status='waived', decision_reason=$4,
                  decided_at=$5, updated_at=$5
            WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3
              AND checkpoint_type='screening_gate' AND status='pending'
              AND machine_result_json->>'operation_id'=$6`,
          [operation.space_id, operation.project_id, state.workflow_id,
            "No source items were returned; screening was skipped automatically.", now, operation.id],
        );
        const workflow = await db.query<{ state_json: unknown }>(
          `SELECT state_json FROM project_research_workflows
            WHERE space_id=$1 AND project_id=$2 AND object_id=$3 FOR UPDATE`,
          [operation.space_id, operation.project_id, state.workflow_id],
        );
        const ranges = historyCoverage(workflow.rows[0]?.state_json).map((range) =>
          range.operation_id === operation.id ? { ...range, status: "completed" as const } : range,
        );
        await db.query(
          `WITH changed AS (UPDATE project_research_workflows
              SET status='paused', current_stage='initial_intake_setup',
                  state_json=jsonb_set(
                    jsonb_set(
                      COALESCE(state_json,'{}'::jsonb) || jsonb_build_object(
                        'draft', COALESCE(state_json->'draft','{}'::jsonb) || jsonb_build_object('status','saved')
                      ),
                      '{last_empty_result}',$4::jsonb,true
                    ),
                    '{coverage_ranges}',$5::jsonb,true
                  )
            WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
           UPDATE space_objects object SET updated_at=$6 FROM changed
            WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
          [operation.space_id, operation.project_id, state.workflow_id,
            JSON.stringify(state.empty_result), JSON.stringify(ranges), now],
        );
      },
      stepOverrides: deriveSkippedAfterScreeningSteps(),
      onStale: "noop",
    });
    // An empty result is among the most common outcomes of a Room-started
    // acquisition, and finishing silently would leave the Room waiting on a
    // terminal event that never comes.
    await this.ports.notifyRoom(operation, "completed", state.empty_result.message);
  }

  async countRelevantItems(spaceId: string, projectId: string, sourceItemIds: string[]): Promise<ScreeningCounts> {
    if (sourceItemIds.length === 0) {
      return { total: 0, relevant: 0, maybe: 0, excluded: 0, missing_full_text: 0, evidence_count: 0, failed_items: 0 };
    }
    const result = await this.db.query<{
      total: string; relevant: string; maybe: string; excluded: string;
      missing_full_text: string; evidence_count: string; failed_items: string;
    }>(
      `WITH requested_items AS (
         SELECT DISTINCT unnest($3::text[]) AS source_item_id
       ), per_source_item AS (
         SELECT requested_items.source_item_id,
                COALESCE(bool_or(pci.triage_status IN ('relevant','included') OR pci.relevance='relevant'), false) AS is_relevant,
                COALESCE(bool_or(pci.triage_status='maybe' OR pci.relevance='maybe'), false) AS is_maybe,
                COALESCE(bool_or(pci.triage_status='excluded' OR pci.relevance='not_relevant'), false) AS is_excluded,
                COALESCE(bool_or(pci.object_id IS NOT NULL), false) AS has_full_text,
                count(DISTINCT pci.evidence_id)::int AS evidence_records,
                COALESCE(bool_or(pci.metadata_json->>'processing_status'='failed'), false) AS has_failed_item
           FROM requested_items
           LEFT JOIN project_corpus_item_sources pcis
             ON pcis.space_id=$1 AND pcis.project_id=$2
            AND pcis.source_item_id=requested_items.source_item_id
           LEFT JOIN source_items provenance_source
             ON provenance_source.id=pcis.source_item_id
            AND provenance_source.space_id=pcis.space_id
            AND provenance_source.deleted_at IS NULL
           LEFT JOIN project_corpus_items pci
             ON pci.id=pcis.corpus_item_id
            AND pci.space_id=pcis.space_id
            AND provenance_source.id IS NOT NULL
            AND pci.status='active'
          GROUP BY requested_items.source_item_id
       )
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE is_relevant)::int AS relevant,
              count(*) FILTER (WHERE NOT is_relevant AND is_maybe)::int AS maybe,
              count(*) FILTER (WHERE NOT is_relevant AND NOT is_maybe AND is_excluded)::int AS excluded,
              count(*) FILTER (WHERE NOT has_full_text)::int AS missing_full_text,
              COALESCE(sum(evidence_records), 0)::int AS evidence_count,
              count(*) FILTER (WHERE has_failed_item)::int AS failed_items
         FROM per_source_item`,
      [spaceId, projectId, sourceItemIds],
    );
    const row = result.rows[0];
    return {
      total: Number(row?.total ?? 0),
      relevant: Number(row?.relevant ?? 0),
      maybe: Number(row?.maybe ?? 0),
      excluded: Number(row?.excluded ?? 0),
      missing_full_text: Number(row?.missing_full_text ?? 0),
      evidence_count: Number(row?.evidence_count ?? 0),
      failed_items: Number(row?.failed_items ?? 0),
    };
  }

  async isSourcePipelineDrained(spaceId: string, state: ResearchOperationState): Promise<boolean> {
    const result = await this.db.query<{ pending_extraction: string; pending_processing: string; pending_events: string }>(
      `SELECT
         (SELECT count(*)::int FROM extraction_jobs
           WHERE space_id=$1 AND status IN ('pending','running')
             AND metadata_json->>'source_backfill_plan_id'=ANY($2::text[])) AS pending_extraction,
         (SELECT count(*)::int FROM source_post_processing_runs
           WHERE space_id=$1 AND source_channel_id=ANY($3::text[]) AND status IN ('queued','running')) AS pending_processing,
         (SELECT count(*)::int FROM jobs
           WHERE space_id=$1 AND job_type='source_post_processing_event' AND status IN ('pending','claimed','running')
             AND payload_json->>'source_channel_id'=ANY($4::text[])) AS pending_events`,
      [spaceId, state.source_backfill_plan_ids?.length ? state.source_backfill_plan_ids : [state.source_backfill_plan_id], state.channel_ids, state.channel_ids],
    );
    return Number(result.rows[0]?.pending_extraction ?? 0) === 0
      && Number(result.rows[0]?.pending_processing ?? 0) === 0
      && Number(result.rows[0]?.pending_events ?? 0) === 0;
  }

  async progressFor(
    spaceId: string,
    projectId: string,
    operationId: string,
    state: ResearchOperationState,
    operationCreatedAt?: string,
  ): Promise<NonNullable<ResearchOperationState["screening_progress"]>> {
    const sourceItemIds = unique(state.source_item_ids);
    const totalItems = sourceItemIds.length;
    const startedAt = optionalString(objectValue(state.screening_progress).started_at)
      ?? state.post_processing_recovery_requested_at
      ?? operationCreatedAt
      ?? null;
    const classified = await this.db.query<{ classified: string; relevant: string; maybe: string; excluded: string }>(
      `SELECT
         count(DISTINCT source_item_id)::int AS classified,
         count(DISTINCT source_item_id) FILTER (WHERE relevance='relevant')::int AS relevant,
         count(DISTINCT source_item_id) FILTER (WHERE relevance='maybe')::int AS maybe,
         count(DISTINCT source_item_id) FILTER (WHERE relevance='not_relevant')::int AS excluded
       FROM source_post_processing_item_decisions
      WHERE space_id=$1 AND project_id=$2
        AND source_channel_id=ANY($3::text[])
        AND source_item_id=ANY($4::text[])
        AND research_question_version=$5`,
      [spaceId, projectId, state.channel_ids, sourceItemIds, state.research_question_version],
    );
    const jobs = await this.db.query<{
      total: string;
      completed: string;
      active: string;
      queued: string;
      running: string;
      failed: string;
    }>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status='completed' AND result_json->>'status'='succeeded')::int AS completed,
         count(*) FILTER (WHERE status IN ('pending','claimed','running'))::int AS active,
         count(*) FILTER (WHERE status='pending')::int AS queued,
         count(*) FILTER (WHERE status IN ('claimed','running'))::int AS running,
         count(*) FILTER (WHERE status='failed' OR (status='completed' AND result_json->>'status'='failed'))::int AS failed
       FROM jobs
      WHERE space_id=$1
        AND job_type='source_post_processing_event'
        AND payload_json->>'phase'='research_recovery'
        AND payload_json->>'recovery_for_operation_id'=$2
        AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)`,
      [spaceId, operationId, startedAt],
    );
    const jobRow = jobs.rows[0];
    const corpus = await this.countRelevantItems(spaceId, projectId, sourceItemIds);
    const classifiedItems = Math.min(totalItems, Number(classified.rows[0]?.classified ?? 0));
    const totalBatches = Number(jobRow?.total ?? 0);
    const completedBatches = Number(jobRow?.completed ?? 0);
    const activeBatches = Number(jobRow?.active ?? 0);
    const queuedBatches = Number(jobRow?.queued ?? 0);
    const runningBatches = Number(jobRow?.running ?? 0);
    const failedBatches = Number(jobRow?.failed ?? 0);
    const phase = failedBatches > 0
      ? "failed"
      : classifiedItems >= totalItems && totalItems > 0
        ? "ready_for_review"
        : totalBatches > 0 ? "screening_batches" : "preparing_batches";
    const message = phase === "failed"
      ? "A screening batch failed; retry is available from the research operation."
      : phase === "ready_for_review"
        ? `All ${classifiedItems.toLocaleString()} items are classified. The screening review is ready.`
        : phase === "screening_batches"
          ? `${runningBatches > 0 ? "Screening" : queuedBatches > 0 ? "Queued for screening" : "Waiting for"} batch ${Math.min(completedBatches + 1, totalBatches)} of ${totalBatches} · ${classifiedItems}/${totalItems} items classified.`
          : `Preparing ${totalItems.toLocaleString()} items for screening in batches of ${SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize}.`;
    return {
      phase,
      total_items: totalItems,
      classified_items: classifiedItems,
      unclassified_items: Math.max(0, totalItems - classifiedItems),
      relevant_items: Number(classified.rows[0]?.relevant ?? 0),
      maybe_items: Number(classified.rows[0]?.maybe ?? 0),
      excluded_items: Number(classified.rows[0]?.excluded ?? 0),
      missing_full_text: corpus.missing_full_text,
      evidence_count: corpus.evidence_count,
      failed_items: corpus.failed_items,
      batch_size: SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize,
      total_batches: totalBatches,
      completed_batches: completedBatches,
      active_batches: activeBatches,
      queued_batches: queuedBatches,
      running_batches: runningBatches,
      failed_batches: failedBatches,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      message,
    };
  }
}

function historyCoverage(value: unknown): Array<{
  from: string; to: string; operation_id: string; status: "pending" | "completed" | "partial";
}> {
  const raw = objectValue(value).coverage_ranges;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const row = objectValue(item);
    const from = optionalString(row.from);
    const to = optionalString(row.to);
    const operationId = optionalString(row.operation_id);
    const status = optionalString(row.status);
    if (!from || !to || !operationId || !["pending", "completed", "partial"].includes(status ?? "")) return [];
    return [{ from, to, operation_id: operationId, status: status as "pending" | "completed" | "partial" }];
  });
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
