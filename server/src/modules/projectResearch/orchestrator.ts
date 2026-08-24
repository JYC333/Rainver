import { createHash, randomUUID } from "node:crypto";
import { getDbPool } from "../../db/pool";
import type { ServerConfig } from "../../config";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import { HttpError, dateIso, objectValue, optionalString, withQueryableTransaction } from "../routeUtils/common";
import { assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { ProjectOperationService } from "../projects/projectOperationService";
import { PgJobQueueRepository } from "../jobs/repository";
import type { JobHandlerRegistry, JobHandlerResult } from "../jobs/handlerRegistry";
import { SourceBackfillPlanningService } from "../sources/sourceBackfillService";
import { SourceBackfillExecutionService } from "../sources/sourceBackfillExecutionService";
import { ARXIV_HISTORY_FLOOR } from "../sources/sourceBackfillStrategy";
import { SourcePostProcessingService } from "../sources/postProcessing/service";
import { SourcePostProcessingRecoveryService } from "../sources/postProcessing/recoveryService";
import { SourceChannelService } from "../sources/channels/sourceChannelService";
import { upsertSourceChannelScanTask } from "../sources/sourceConnectionScheduler";
import { computeNextCheckAt } from "../sources/sourceScanCadence";
import { ProjectResearchRepository } from "./repository";
import { ProjectResearchAreaService } from "./areaService";
import { ProjectResearchReportStatusService } from "./reportStatusService";
import { rejectLegacyResearchRuntimeFields } from "./inputValidation";
import {
  normalizeResearchScope,
  researchScopeFromRefinement,
  type ResearchScopeContext,
} from "./researchContext";
import {
  ProjectResearchExecutionProfileService,
  type ResearchExecutionSelection,
} from "./executionProfileService";
import {
  deriveSkippedAfterScreeningSteps,
  deriveStepStates,
  operationSteps,
  researchStageIndex,
  researchState,
  type HistoryMode,
  type ResearchOperationError,
  type ResearchOperationState,
  type ResearchReportDepth,
  type ResearchStepOverride,
  type ResearchMutationResult,
} from "./operationProjection";
import { ProjectResearchIntegrityMonitorService } from "./integrityMonitorService";
import {
  ProjectResearchStandingComparisonService,
  STANDING_COMPARISON_JOB_TYPE,
  STANDING_COMPARISON_RECONCILE_JOB_TYPE,
} from "./standingComparisonService";
import {
  createResearchWorkflow,
  researchWorkflowProjection,
  setResearchWorkflowThread,
  type ResearchWorkflowRow,
} from "./workflowOntology";
import { ProjectResearchRetryService } from "./pipeline/retryService";
import { ProjectResearchInitialIntakeCoordinator } from "./pipeline/initialIntakeCoordinator";
import { ProjectResearchMonitoringCoordinator } from "./pipeline/monitoringCoordinator";
import { setResearchOperationState } from "./pipeline/operationProjectionWriter";
import { upsertPendingResearchCheckpoint } from "./checkpointWriter";
import { ProjectResearchScreeningCoordinator } from "./pipeline/screeningCoordinator";
import {
  ProjectResearchSynthesisCoordinator,
  type QueueSynthesisInput,
} from "./pipeline/synthesisCoordinator";
import { startSynthesisOnlyExecution } from "./synthesisOnlyExecution";
import { startResearchReconcilePass } from "./researchPassExecution";
import {
  summarizeBackfillFailures,
  backfillCanProceed,
  isDeferredBackfillPlan,
  type FailedBackfillRow,
} from "./backfillFailureDiagnostics";
import {
  resolveResearchThreadScope,
  normalizeThreadScope,
  checkPinnedThreadDrift,
  type ResearchThreadScopeRef,
} from "./threadScope";
import { InquiryIterationService } from "../inquiry/iterationService";
import { RESEARCH_OPERATION_FAILURE_NOTIFY_JOB } from "./pipeline/researchOperationFailureNotifyJob";
import {
  PROJECT_RESEARCH_MONITORING_OVERLAP_HOURS,
  latestPublicationWatermarkForItems,
} from "./monitoringWindow";
import { tryCompleteSearchStepForWorkflow, tryQueueAdviceForWorkflowThread } from "../inquiry/adviceJob";

const MONITORING_FIELDS = new Set(["submittedDate", "lastUpdatedDate"]);
const MAX_ITEMS_DEFAULT = 10_000;
const OVERLAP_HOURS = PROJECT_RESEARCH_MONITORING_OVERLAP_HOURS;

interface ResearchInput {
  workflowId: string | null;
  researchQuestion: string;
  requestedThreadId: string | null;
  threadScope: ResearchThreadScopeRef[];
  sourceChannelIds: string[];
  historyMode: HistoryMode;
  from: string | null;
  to: string | null;
  maxItems: number;
  monitoringField: "submittedDate" | "lastUpdatedDate";
  schedule: "daily";
  agentId: string;
  runtimeProfileId: string;
  execution: ResearchExecutionSelection;
  idempotencyKey: string;
  reportDepth: ResearchReportDepth;
  questionRefineSkipped: boolean;
  queryStrategyId: string | null;
  researchScope: ResearchScopeContext;
}

interface InitialIntakeDraft {
  researchQuestion: string;
  requestedThreadId: string | null;
  researchContextVersionId: string | null;
  sourceChannelIds: string[];
  historyMode: HistoryMode;
  from: string | null;
  to: string | null;
  maxItems: number;
  monitoringField: "submittedDate" | "lastUpdatedDate";
  schedule: "daily";
  execution: ResearchExecutionSelection;
  reportDepth: ResearchReportDepth;
  questionRefineSkipped: boolean;
  queryStrategyId: string | null;
  questionRefinement: Record<string, unknown> | null;
}

interface OperationRow {
  id: string;
  space_id: string;
  project_id: string;
  status: string;
  progress_json: unknown;
  created_at?: string;
  current_execution_id?: string | null;
}

interface OperationRead extends OperationRow {
  steps: Record<string, unknown>[];
  links: Record<string, unknown>[];
}

type WorkflowRow = ResearchWorkflowRow;

export class ProjectResearchOrchestrator {
  private activePassExecutionId: string | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  /** Records a successful zero-item source scan and closes an explicit
   * incremental operation once every channel scan it started has settled. */
  async onSourceScanCompleted(input: {
    spaceId: string;
    sourceChannelId: string | null;
    scanJobId: string;
    scannedAt: string;
    scanWindowStart: string | null;
    scanWindowEnd: string | null;
    newItemCount: number;
  }): Promise<void> {
    return this.monitoringCoordinator().onSourceScanCompleted(input);
  }

  private async startEmptyScanPass(
    input: {
      spaceId: string;
      sourceChannelId: string | null;
      scanJobId: string;
      scannedAt: string;
      scanWindowStart: string | null;
      scanWindowEnd: string | null;
      newItemCount: number;
    },
    operationId: string,
  ): Promise<void> {
    const operation = await this.operation(input.spaceId, operationId);
    if (!operation) return;
    const userId = await this.projectWriterActor(input.spaceId, operation.project_id);
    if (!userId) return;
    await startResearchReconcilePass(
      this.db,
      { spaceId: input.spaceId, userId },
      this.config,
      operation,
      "empty_scan",
      {
        kind: "empty_scan",
        sourceChannelId: input.sourceChannelId,
        scanJobId: input.scanJobId,
        scannedAt: input.scannedAt,
        scanWindowStart: input.scanWindowStart,
        scanWindowEnd: input.scanWindowEnd,
        newItemCount: input.newItemCount,
      },
    );
  }

  async executeEmptyScanPass(
    input: {
      spaceId: string;
      sourceChannelId: string | null;
      scanJobId: string;
      scannedAt: string;
      scanWindowStart: string | null;
      scanWindowEnd: string | null;
      newItemCount: number;
    },
    operationId: string,
    executionId: string,
  ): Promise<void> {
    this.activePassExecutionId = executionId;
    const operation = await this.operation(input.spaceId, operationId);
    if (!operation || operation.current_execution_id !== executionId) {
      throw new HttpError(409, "Empty scan is not governed by this Workflow Execution");
    }
    await this.monitoringCoordinator().completeEmptyScanPass(input, operationId);
  }

  async startInitialIntake(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const project = await this.db.query<{ current_focus: string | null }>(
      `SELECT current_focus FROM projects WHERE space_id=$1 AND id=$2`,
      [identity.spaceId, projectId],
    );
    const input = normalizeInitialIntakeInput(body, project.rows[0]?.current_focus ?? null);
    if (!this.config) throw new HttpError(503, "Auto research requires server configuration");
    const execution = await new ProjectResearchExecutionProfileService(this.db, this.config)
      .resolve(identity, input.execution);
    input.agentId = execution.agentId;
    input.runtimeProfileId = execution.runtimeProfileId;

    return withQueryableTransaction(this.db, (db) =>
      new ProjectResearchOrchestrator(db, this.config).startInitialIntakeLocked(identity, projectId, input),
    );
  }

  async saveInitialIntakeDraft(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const project = await this.db.query<{ current_focus: string | null }>(
      `SELECT current_focus FROM projects WHERE space_id=$1 AND id=$2`,
      [identity.spaceId, projectId],
    );
    const draft = normalizeInitialIntakeDraft(body, project.rows[0]?.current_focus ?? null);
    const workflowId = optionalString(body.workflow_id);
    return withQueryableTransaction(this.db, (db) =>
      new ProjectResearchOrchestrator(db, this.config).saveInitialIntakeDraftLocked(identity, projectId, draft, workflowId),
    );
  }

  private async saveInitialIntakeDraftLocked(
    identity: SpaceUserIdentity,
    projectId: string,
    draft: InitialIntakeDraft,
    requestedWorkflowId: string | null,
  ) {
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    if (!draft.requestedThreadId) throw new HttpError(422, "thread_id is required for an initial material intake draft");
    const existing = requestedWorkflowId
      ? await this.workflow(identity.spaceId, projectId, requestedWorkflowId, true, true)
      : await this.workflowByThread(identity.spaceId, projectId, draft.requestedThreadId, true);
    if (requestedWorkflowId && !existing) throw new HttpError(404, "Research workflow not found");
    const existingThreadId = existing?.primary_thread_id ?? null;
    if (existing && existingThreadId !== draft.requestedThreadId) {
      throw new HttpError(409, "The selected research workflow belongs to a different Inquiry Thread");
    }
    if (existing?.status === "active") {
      throw new HttpError(409, "An active research workflow cannot be edited after initial material intake has started");
    }
    if (existing && !["not_started", "paused"].includes(existing.status)) {
      throw new HttpError(409, "This research workflow can no longer be edited");
    }
    const workflowId = existing?.id ?? randomUUID();
    const startedBaseline = await this.db.query<{ id: string }>(
      `SELECT id FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research'
          AND progress_json->>'workflow_id'=$3
          AND progress_json->>'run_kind'='baseline'
        ORDER BY created_at DESC LIMIT 1`,
      [identity.spaceId, projectId, workflowId],
    );
    if (startedBaseline.rows[0]) {
      const latestBaseline = await this.db.query<{ status: string; progress_json: unknown }>(
        `SELECT status, progress_json FROM project_operations
          WHERE space_id=$1 AND project_id=$2 AND kind='research'
            AND progress_json->>'workflow_id'=$3
            AND progress_json->>'run_kind'='baseline'
          ORDER BY created_at DESC LIMIT 1`,
        [identity.spaceId, projectId, workflowId],
      );
      const latestProgress = objectValue(latestBaseline.rows[0]?.progress_json);
      const emptyResult = objectValue(latestProgress.empty_result);
      const canReconfigureEmptyIntake = latestBaseline.rows[0]?.status === "completed"
        && emptyResult.kind === "no_source_items";
      if (!canReconfigureEmptyIntake) {
        throw new HttpError(409, "Initial material intake already started; its execution snapshot cannot be edited");
      }
    }

    const now = new Date().toISOString();
    const state = initialIntakeDraftState(draft, now);
    if (existing) {
      await this.db.query(
        `WITH changed AS (UPDATE project_research_workflows
            SET status='not_started', current_stage='initial_intake_setup',
                state_json=$4::jsonb
          WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
         UPDATE space_objects object SET updated_at=$5,title=$6 FROM changed
          WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
        [identity.spaceId, projectId, workflowId, JSON.stringify(state), now, draft.researchQuestion.slice(0, 512)],
      );
      await setResearchWorkflowThread(this.db, {
        spaceId: identity.spaceId, projectId, workflowId,
        threadId: draft.requestedThreadId, userId: identity.userId, now,
      });
    } else {
      await createResearchWorkflow(this.db, {
        id: workflowId, spaceId: identity.spaceId, projectId,
        title: draft.researchQuestion, status: "not_started", currentStage: "initial_intake_setup",
        state, startedByUserId: identity.userId, primaryThreadId: draft.requestedThreadId, now,
      });
    }
    const workflow = await this.workflow(identity.spaceId, projectId, workflowId, true);
    if (!workflow) throw new HttpError(500, "Failed to save initial material intake setup");
    return workflowOutput(workflow);
  }

  async startHistoricalBackfill(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    body: Record<string, unknown>,
  ) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, (db) =>
      new ProjectResearchOrchestrator(db, this.config).startHistoricalBackfillLocked(identity, projectId, workflowId, body),
    );
  }

  async applyQuestionForward(identity: SpaceUserIdentity, projectId: string, workflowId: string) {
    return this.resolveQuestionChange(identity, projectId, workflowId, "apply_forward");
  }

  async questionChangeImpact(identity: SpaceUserIdentity, projectId: string, workflowId: string) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const workflow = await this.workflow(identity.spaceId, projectId, workflowId, true);
    if (!workflow) throw new HttpError(409, "There is no active research workflow to update");
    const state = objectValue(workflow.state_json);
    const version = questionVersion(state);
    const scope = normalizeThreadScope(state.thread_scope);
    const pinned = scope[0];
    const [screened, reports] = await Promise.all([
      this.db.query<{ count: string }>(
        `SELECT count(DISTINCT source_item_id)::int AS count
           FROM source_post_processing_item_decisions
          WHERE space_id=$1 AND project_id=$2 AND research_question_version=$3`,
        [identity.spaceId, projectId, version],
      ),
      this.db.query<{ count: string }>(
        `SELECT count(*)::int AS count
           FROM project_research_reports
          WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3`,
        [identity.spaceId, projectId, workflow.id],
      ),
    ]);
    const currentQuestion = pinned
      ? (await checkPinnedThreadDrift(this.db, identity.spaceId, projectId, pinned)).current?.statement ?? null
      : null;
    return {
      workflow_id: workflow.id,
      previous_question: optionalString(state.research_question),
      current_question: currentQuestion,
      previous_version: version,
      screened_items: Number(screened.rows[0]?.count ?? 0),
      reports: Number(reports.rows[0]?.count ?? 0),
    };
  }

  async resolveQuestionChange(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    strategy: "rescreen" | "synthesis_only" | "apply_forward",
  ) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, (db) =>
      new ProjectResearchOrchestrator(db, this.config).resolveQuestionChangeLocked(identity, projectId, workflowId, strategy),
    );
  }

  async generateReportSnapshot(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      const service = new ProjectResearchOrchestrator(db, this.config);
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const workflow = await service.workflow(identity.spaceId, projectId, null, true);
      if (!workflow) throw new HttpError(409, "There is no active research workflow to synthesize");
      await service.assertResearchQuestionAligned(identity.spaceId, projectId, workflow.state_json);
      const active = await service.activeResearchOperation(identity.spaceId, projectId, workflow.id);
      if (active) throw new HttpError(409, "Wait for the active research operation to finish before generating a report snapshot");
      const corpus = await db.query<{ source_item_id: string }>(
        `SELECT DISTINCT pcis.source_item_id
           FROM project_corpus_item_sources pcis
           JOIN project_corpus_items pci ON pci.id=pcis.corpus_item_id AND pci.space_id=pcis.space_id
           JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
          WHERE pcis.space_id=$1 AND pcis.project_id=$2 AND pci.status='active'
          ORDER BY pcis.source_item_id`,
        [identity.spaceId, projectId],
      );
      const sourceItemIds = corpus.rows.map((row) => row.source_item_id);
      if (!sourceItemIds.length) throw new HttpError(409, "The project corpus has no material to synthesize");
      const key = `snapshot:${workflow.id}:${new Date().toISOString()}`;
      const state = incrementalStateFromWorkflow(workflow.state_json, workflow.id, sourceItemIds, key, null);
      state.run_kind = "synthesis_only";
      state.current_stage = "synthesis";
      state.stage_state = "running";
      // A report snapshot is an immutable execution-per-pass
      // WorkflowExecution, just like every other Project Research run kind.
      const operation = await startSynthesisOnlyExecution(db, identity, this.config, projectId, workflow, state);
      return service.readOperation(identity, projectId, operation.id);
    });
  }

  private async resolveQuestionChangeLocked(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    strategy: "rescreen" | "synthesis_only" | "apply_forward",
  ) {
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const workflow = await this.workflow(identity.spaceId, projectId, workflowId, true);
    if (!workflow) throw new HttpError(409, "There is no active research workflow to update");
    const workflowState = objectValue(workflow.state_json);
    const workflowQuestion = optionalString(workflowState.research_question);
    const ruleIds = stringArray(workflowState.source_post_processing_rule_ids);
    if (!workflowQuestion) throw new HttpError(409, "The research workflow has no question snapshot to update");
    const currentThreadScope = normalizeThreadScope(workflowState.thread_scope);
    const scopedThread = currentThreadScope[0];
    if (!scopedThread) throw new HttpError(409, "The research workflow has no Inquiry Thread scope");
    const { drifted, current: currentThread } = await checkPinnedThreadDrift(
      this.db, identity.spaceId, projectId, scopedThread, { forUpdate: true },
    );
    if (!currentThread) throw new HttpError(409, "The scoped Inquiry Thread is no longer active");
    if (!drifted) return workflowOutput(workflow);
    const currentQuestion = currentThread.statement;

    const active = await this.activeResearchOperation(identity.spaceId, projectId, workflow.id);
    if (active) throw new HttpError(409, "Wait for the active research operation to finish before applying a new research question");
    const processing = await this.db.query<{ id: string }>(
      `SELECT id FROM source_post_processing_runs
        WHERE space_id=$1 AND project_id=$2 AND status IN ('queued','running')
        ORDER BY created_at DESC LIMIT 1`,
      [identity.spaceId, projectId],
    );
    if (processing.rows[0]) throw new HttpError(409, "Wait for source processing to finish before applying a new research question");
    if (ruleIds.length > 0) {
      const queuedProcessing = await this.db.query<{ id: string }>(
        `SELECT id FROM jobs
          WHERE space_id=$1 AND job_type='source_post_processing_event'
            AND status IN ('pending','claimed','running')
            AND payload_json->>'rule_id'=ANY($2::text[])
          ORDER BY created_at DESC LIMIT 1`,
        [identity.spaceId, ruleIds],
      );
      if (queuedProcessing.rows[0]) throw new HttpError(409, "Wait for queued source screening to finish before applying a new research question");
    }

    const now = new Date().toISOString();
    const previousVersion = questionVersion(workflowState);
    const nextVersion = previousVersion + 1;
    const nextState = {
      ...workflowState,
      research_question: currentQuestion,
      research_question_version: nextVersion,
      thread_scope: [{
        thread_id: currentThread.id,
        version: currentThread.version,
        kind: "question",
        statement: currentThread.statement,
      }],
      research_scope: { sub_questions: [], in: [], out: [] },
      question_refinement: null,
      previous_research_question: workflowQuestion,
      previous_research_question_version: previousVersion,
      question_changed_at: now,
      question_change_mode: strategy,
      question_history: [
        { from: workflowQuestion, to: currentQuestion, from_version: previousVersion, to_version: nextVersion, applied_at: now, applied_by_user_id: identity.userId, mode: strategy },
      ],
    };
    await this.db.query(
      `WITH changed AS (UPDATE project_research_workflows SET state_json=$4::jsonb
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
       UPDATE space_objects object SET updated_at=$5,title=$6 FROM changed
        WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
      [identity.spaceId, projectId, workflow.id, JSON.stringify(nextState), now, currentThread.statement.slice(0, 512)],
    );
    await setResearchWorkflowThread(this.db, {
      spaceId: identity.spaceId, projectId, workflowId: workflow.id,
      threadId: currentThread.id, userId: identity.userId, now,
    });

    if (ruleIds.length > 0) {
      const rules = await this.db.query<{ id: string; source_channel_id: string; input_config_json: unknown }>(
        `SELECT id, source_channel_id, input_config_json
           FROM source_post_processing_rules
          WHERE space_id=$1 AND id=ANY($2::text[]) AND project_id=$3 AND status <> 'archived'`,
        [identity.spaceId, ruleIds, projectId],
      );
      const service = new SourcePostProcessingService(this.db, this.config!);
      for (const rule of rules.rows) {
        const inputConfig = objectValue(rule.input_config_json);
        const relevanceProfile = objectValue(inputConfig.relevance_profile);
        await service.updateRule(identity, rule.source_channel_id, rule.id, {
          input_config_json: {
            ...inputConfig,
            research_question_version: nextVersion,
            summary_goal: currentQuestion,
            retrieval_context: { ...objectValue(inputConfig.retrieval_context), query: currentQuestion },
            relevance_profile: {
              ...relevanceProfile,
              objective: currentQuestion,
              include_criteria: [],
              exclude_criteria: [],
              must_have: [],
              nice_to_have: [],
            },
          },
        });
      }
    }

    if (strategy === "apply_forward") {
      const updated = await this.workflow(identity.spaceId, projectId, workflow.id);
      if (!updated) throw new HttpError(500, "Failed to apply the research question to the workflow");
      return workflowOutput(updated);
    }

    const corpus = await this.db.query<{ source_item_id: string }>(
      `SELECT DISTINCT source_item_id
         FROM project_corpus_items
        WHERE space_id=$1 AND project_id=$2 AND status='active' AND source_item_id IS NOT NULL
        ORDER BY source_item_id`,
      [identity.spaceId, projectId],
    );
    const sourceItemIds = corpus.rows.map((row) => row.source_item_id);
    if (sourceItemIds.length === 0) throw new HttpError(409, "The project corpus has no material to process for the new question");

    const key = `question:${strategy}:${workflow.id}:v${nextVersion}`;
    const state = incrementalStateFromWorkflow(nextState, workflow.id, sourceItemIds, key, null);
    state.run_kind = strategy === "rescreen" ? "question_rescreen" : "synthesis_only";
    state.research_question = currentQuestion;
    state.research_question_version = nextVersion;

    if (strategy === "rescreen") {
      await this.db.query(
        `UPDATE project_corpus_items
            SET triage_status='new', source_decision_id=NULL, relevance=NULL, confidence=NULL,
                reason=NULL, last_reviewed_at=NULL, updated_at=$3
          WHERE space_id=$1 AND project_id=$2 AND status='active'
            AND source_item_id IS NOT NULL AND triage_confirmed_by_user=false`,
        [identity.spaceId, projectId, now],
      );
      const operation = await this.createOperation(identity, projectId, {
        title: "Re-screen corpus for revised research question",
        intentText: `Re-screen the existing corpus for: ${currentQuestion}`,
        steps: operationSteps(),
        state,
      });
      await this.enqueueReconcile(identity.spaceId, identity.userId, operation.id, "question_rescreen");
      const updatedWorkflow = await this.workflow(identity.spaceId, projectId, workflow.id);
      if (!updatedWorkflow) throw new HttpError(500, "Research workflow disappeared while starting re-screening");
      return { workflow: workflowOutput(updatedWorkflow), operation: await this.readOperation(identity, projectId, operation.id) };
    }

    state.current_stage = "synthesis";
    state.stage_state = "running";
    const operation = await this.createOperation(identity, projectId, {
      title: "Re-run synthesis for revised research question",
      intentText: `Re-synthesize the existing corpus for: ${currentQuestion}`,
      steps: operationSteps(),
      state,
    });
    await startResearchReconcilePass(
      this.db,
      identity,
      this.config,
      operation,
      "question_change_synthesis",
    );
    const updatedWorkflow = await this.workflow(identity.spaceId, projectId, workflow.id);
    if (!updatedWorkflow) throw new HttpError(500, "Research workflow disappeared while starting synthesis");
    return { workflow: workflowOutput(updatedWorkflow), operation: await this.readOperation(identity, projectId, operation.id) };
  }

  private async startHistoricalBackfillLocked(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    body: Record<string, unknown>,
  ) {
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const workflow = await this.workflow(identity.spaceId, projectId, workflowId, true);
    if (!workflow) throw new HttpError(404, "Research workflow not found");
    await this.assertResearchQuestionAligned(identity.spaceId, projectId, workflow.state_json);
    const workflowState = objectValue(workflow.state_json);
    const monitoring = objectValue(workflowState.monitoring);
    if (monitoring.active !== true) throw new HttpError(409, "Historical extension requires a completed baseline with active monitoring");
    if (objectValue(workflowState.initial_intake).history_mode === "all_available") {
      throw new HttpError(409, "All available history baseline does not need an earlier history extension");
    }
    const channelIds = stringArray(workflowState.channel_ids);
    const bindingIds = stringArray(workflowState.project_source_binding_ids);
    const ruleIds = stringArray(workflowState.source_post_processing_rule_ids);
    if (!channelIds.length || channelIds.length !== bindingIds.length || channelIds.length !== ruleIds.length) throw new HttpError(409, "The research workflow has not completed monitor setup");

    const coverage = historyCoverage(workflowState);
    if (coverage.some((range) => range.status === "partial")) {
      throw new HttpError(409, "Continue the partial history backfill before extending into an earlier range");
    }
    const currentFrom = coverage.map((range) => range.from).sort()[0] ?? optionalString(objectValue(workflowState.initial_intake).from);
    if (!currentFrom) throw new HttpError(409, "The research workflow has no recorded historical coverage");
    const from = optionalString(body.from);
    const to = optionalString(body.to) ?? currentFrom;
    if (!from) throw new HttpError(422, "from is required for historical backfill");
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) {
      throw new HttpError(422, "from must be earlier than to");
    }
    if (Date.parse(from) < Date.parse(ARXIV_HISTORY_FLOOR)) {
      throw new HttpError(422, `from must not be earlier than ${ARXIV_HISTORY_FLOOR}`);
    }
    if (Date.parse(to) > Date.parse(currentFrom)) {
      throw new HttpError(422, "to must not be later than the earliest covered history date");
    }
    if (coverage.some((range) => Date.parse(from) < Date.parse(range.to) && Date.parse(to) > Date.parse(range.from))) {
      throw new HttpError(409, "The requested history range overlaps existing research coverage");
    }
    const maxItems = body.max_items === undefined ? MAX_ITEMS_DEFAULT : Number(body.max_items);
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS_DEFAULT) {
      throw new HttpError(422, `max_items must be an integer between 1 and ${MAX_ITEMS_DEFAULT}`);
    }
    const idempotencyKey = optionalString(body.idempotency_key) ?? fingerprintOf({ workflowId, from, to, maxItems, source_channel_ids: channelIds });
    const prior = await this.operationByIdempotency(identity.spaceId, projectId, idempotencyKey);
    if (prior && prior.status !== "failed" && prior.status !== "cancelled") return this.readOperation(identity, projectId, prior.id);
    const active = await this.activeResearchOperation(identity.spaceId, projectId, workflowId);
    if (active) throw new HttpError(409, "Another Project Research operation is already active for this workflow");

    const normalizedFrom = new Date(from).toISOString();
    const normalizedTo = new Date(to).toISOString();
    const fingerprint = fingerprintOf({ workflowId, run_kind: "historical_backfill", from: normalizedFrom, to: normalizedTo, maxItems, source_channel_ids: channelIds });
    const state = historicalBackfillStateFromWorkflow(workflowState, workflowId, normalizedFrom, normalizedTo, maxItems, idempotencyKey, fingerprint);
    const operation = await this.createOperation(identity, projectId, {
      title: "Extend automatic research history",
      intentText: `Import earlier research history from ${normalizedFrom} to ${normalizedTo}.`,
      steps: operationSteps(),
      state,
    });
    try {
      const planner = new SourceBackfillPlanningService(this.db, this.config);
      const plans: Record<string, unknown>[] = [];
      for (let index = 0; index < channelIds.length; index += 1) {
        const plan = await planner.create(identity, channelIds[index]!, {
          strategy: {
            window_unit: "date_window",
            history_mode: "bounded_range",
            from: normalizedFrom,
            to: normalizedTo,
            window_size: 30,
            max_items: maxItems,
            direction: "backward",
            monitoring_field: optionalString(objectValue(workflowState.monitoring).field) ?? "submittedDate",
          },
          quota_policy: { window: "minute", limit_count: 10 },
          idempotency_key: `${idempotencyKey}:backfill:${channelIds[index]}`,
          project_source_binding_id: bindingIds[index],
          project_operation_id: operation.id,
        });
        await new SourceBackfillExecutionService(this.db).startUserAuthorized(
          identity.spaceId,
          String(plan.id),
          operation.id,
          identity.userId,
        );
        plans.push(plan);
      }
      state.source_backfill_plan_ids = plans.map((plan) => String(plan.id));
      state.source_backfill_plan_id = state.source_backfill_plan_ids[0] ?? null;
      state.coverage_ranges = [{ from: normalizedFrom, to: normalizedTo, operation_id: operation.id, status: "pending" }];
      state.current_stage = "backfill";
      state.stage_state = "running";
      await this.setState(operation, state, [
        { seq: 0, status: "skipped" },
        { seq: 1, status: "active", detail: { plan_ids: state.source_backfill_plan_ids, authorization: "explicit_user_start" } },
        { seq: 2, status: "pending" },
        { seq: 3, status: "pending" },
        { seq: 4, status: "pending" },
      ]);
      await this.appendWorkflowCoverage(identity.spaceId, projectId, workflowId, {
        from: normalizedFrom,
        to: normalizedTo,
        operation_id: operation.id,
        status: "pending",
      });
      await new ProjectOperationService(this.db).link(identity.spaceId, projectId, operation.id, "research_workflow", workflowId, "workflow_definition");
      for (let index = 0; index < plans.length; index += 1) {
        await new ProjectOperationService(this.db).link(identity.spaceId, projectId, operation.id, "project_source_binding", bindingIds[index]!, "source_binding");
        await new ProjectOperationService(this.db).link(identity.spaceId, projectId, operation.id, "source_backfill_plan", String(plans[index]!.id), "history_backfill");
      }
      return this.readOperation(identity, projectId, operation.id);
    } catch (error) {
      await this.failOperation(operation, error instanceof Error ? error.message : "Historical backfill setup failed");
      throw error;
    }
  }

  async triggerIncremental(identity: SpaceUserIdentity, projectId: string, workflowId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      return new ProjectResearchOrchestrator(db, this.config).triggerIncrementalLocked(identity, projectId, workflowId, body);
    });
  }

  private async triggerIncrementalLocked(identity: SpaceUserIdentity, projectId: string, workflowId: string, body: Record<string, unknown>) {
    const workflow = await this.workflow(identity.spaceId, projectId, workflowId, true);
    if (!workflow) throw new HttpError(404, "Research workflow not found");
    await this.assertResearchQuestionAligned(identity.spaceId, projectId, workflow.state_json);
    const state = researchState(workflow.state_json);
    const bindingIds = state.project_source_binding_ids?.length
      ? state.project_source_binding_ids
      : state.project_source_binding_id ? [state.project_source_binding_id] : [];
    if (!(state.channel_ids?.length ?? 0) || bindingIds.length !== state.channel_ids.length) {
      throw new HttpError(409, "The research workflow has not completed monitor setup");
    }
    if (objectValue(objectValue(workflow.state_json).monitoring).active !== true && state.monitoring_active !== true) {
      throw new HttpError(409, "Baseline research must complete its review checkpoints before incremental monitoring can run");
    }
    const historical = await this.activeHistoricalBackfill(identity.spaceId, projectId, workflowId);
    if (historical) throw new HttpError(409, "A historical backfill is already updating this research workflow");
    const key = optionalString(body.idempotency_key) ?? `incremental:${workflowId}:${new Date().toISOString().slice(0, 13)}`;
    const workflowState = objectValue(workflow.state_json);
    const pendingItemIds = stringArray(workflowState.pending_incremental_source_item_ids);
    const itemIds = unique([...pendingItemIds, ...stringArray(body.source_item_ids)]);
    const consumePending = async () => {
      if (pendingItemIds.length === 0) return;
      const now = new Date().toISOString();
      await this.db.query(
        `WITH changed AS (UPDATE project_research_workflows
          SET state_json=state_json - 'pending_incremental_source_item_ids'
          WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
         UPDATE space_objects object SET updated_at=$4 FROM changed
          WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
        [identity.spaceId, projectId, workflowId, now],
      );
    };
    const prior = await this.operationByIdempotency(identity.spaceId, projectId, key);
    if (prior && prior.status !== "failed" && prior.status !== "cancelled") {
      const priorState = researchState(prior.progress_json);
      if (pendingItemIds.length > 0
        && ["active", "waiting_review"].includes(prior.status)
        && priorState.run_kind === "incremental"
        && priorState.workflow_id === workflowId) {
        const merged = { ...priorState, source_item_ids: unique([...priorState.source_item_ids, ...itemIds]) };
        await this.setState(prior, merged, deriveStepStates(merged));
        await consumePending();
      }
      return this.readOperation(identity, projectId, prior.id);
    }
    const awaitingSourceScan = itemIds.length === 0;
    if (awaitingSourceScan) {
      if (!this.config) throw new HttpError(503, "Incremental source scans require server configuration");
      if (!state.channel_ids.length || !this.config) throw new HttpError(409, "Research workflow has no active search channels");
      for (const channelId of state.channel_ids) {
        await new SourceChannelService(this.db, this.config).scan(identity, channelId);
      }
    }
    const existing = await this.activeIncremental(identity.spaceId, projectId, workflowId);
    if (existing) {
      if (awaitingSourceScan) return this.readOperation(identity, projectId, existing.id);
      const existingState = researchState(existing.progress_json);
      const merged = { ...existingState, source_item_ids: unique([...existingState.source_item_ids, ...itemIds]) };
      await this.setState(existing, merged, deriveStepStates(merged));
      await consumePending();
      return this.readOperation(identity, projectId, existing.id);
    }

    const operationProjection = incrementalStateFromWorkflow(workflow.state_json, workflowId, itemIds, key, null);
    operationProjection.awaiting_source_scan = awaitingSourceScan;
    const operation = await this.createOperation(identity, projectId, {
      title: "Run incremental research update",
      intentText: "Scan new source content and prepare a human-reviewed research delta.",
      steps: operationSteps(),
      state: operationProjection,
    });
    await consumePending();
    await this.enqueueReconcile(identity.spaceId, identity.userId, operation.id, "incremental_trigger");
    return this.readOperation(identity, projectId, operation.id);
  }

  async decideCheckpoint(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    checkpointId: string,
    body: Record<string, unknown>,
  ) {
    const research = new ProjectResearchRepository(this.db);
    const checkpoint = await research.decideCheckpoint(identity, projectId, workflowId, checkpointId, body);
    if (checkpoint.user_decision === "approved" || checkpoint.user_decision === "waived") {
      await this.resumeAfterCheckpoint(identity.spaceId, identity.userId, projectId, workflowId, checkpointId);
    } else if (checkpoint.user_decision === "rejected") {
      const operation = await this.operationForCheckpoint(identity.spaceId, projectId, checkpointId);
      if (operation) {
        await new ProjectResearchReportStatusService(this.db).transitionForOperation(identity.spaceId, operation.id, "rejected");
        await this.failOperation(operation, "Checkpoint rejected by user");
      }
    }
    return checkpoint;
  }

  async reconcileOperation(spaceId: string, operationId: string): Promise<void> {
    const operation = await this.operation(spaceId, operationId);
    if (!operation || ["completed", "failed", "cancelled"].includes(operation.status)) return;
    const userId = await this.projectWriterActor(spaceId, operation.project_id);
    if (!userId) {
      await this.failOperation(operation, "Research reconciliation requires a project writer");
      return;
    }
    await startResearchReconcilePass(
      this.db,
      { spaceId, userId },
      this.config,
      operation,
      "reconcile",
    );
  }

  async executeReconcilePass(
    spaceId: string,
    operationId: string,
    executionId: string,
  ): Promise<void> {
    this.activePassExecutionId = executionId;
    const row = await this.operation(spaceId, operationId);
    if (!row || row.status === "cancelled" || row.status === "completed") return;
    if (row.current_execution_id !== executionId) {
      throw new HttpError(409, "Research operation is not governed by this Workflow Execution");
    }
    const state = researchState(row.progress_json);
    if (!state.workflow_id) return;

    if (state.current_stage === "monitor_setup") {
      await this.reconcileMonitorSetup(row, state);
      return;
    }

    if (state.current_stage === "synthesis") {
      if (!state.synthesis_run_id) {
        await this.recoverUnboundSynthesisStage(spaceId, row, state);
        return;
      }
      await this.reconcileSynthesisStage(spaceId, row, state);
      return;
    }

    if (state.current_stage === "comparison") {
      await this.reconcileComparisonStage(spaceId, row, state);
      return;
    }

    if (state.current_stage === "idea_review") {
      await this.reconcileIdeaReviewStage(spaceId, row, state);
      return;
    }

    const backfillPlanIds = state.source_backfill_plan_ids?.length
      ? state.source_backfill_plan_ids
      : state.source_backfill_plan_id ? [state.source_backfill_plan_id] : [];
    if ((state.run_kind === "baseline" || state.run_kind === "historical_backfill") && backfillPlanIds.length > 0) {
      const plans = await this.db.query<{
        id: string;
        status: string;
        segments_total: number | null;
        segments_completed: number | null;
        segments_failed: number | null;
        items_ingested: number | null;
        next_eligible_at: string | null;
        error_json: unknown;
        updated_at: string | null;
      }>(
        `SELECT id, status, segments_total, segments_completed, segments_failed, items_ingested,
                next_eligible_at, error_json, updated_at
           FROM source_backfill_plans
          WHERE id=ANY($1::text[]) AND space_id=$2`,
        [backfillPlanIds, spaceId],
      );
      const segmentProgress = await this.db.query<{
        total_segments: number;
        completed_segments: number;
        failed_segments: number;
        running_segments: number;
        pending_segments: number;
        deferred_segments: number;
        next_retry_at: string | null;
      }>(
        `SELECT
            count(*)::int AS total_segments,
            count(*) FILTER (WHERE status IN ('succeeded', 'skipped'))::int AS completed_segments,
            count(*) FILTER (WHERE status='failed')::int AS failed_segments,
            count(*) FILTER (WHERE status='running')::int AS running_segments,
            count(*) FILTER (WHERE status='pending')::int AS pending_segments,
            count(*) FILTER (
              WHERE status='pending'
                AND error_json->>'deferred_retry'='true'
                AND next_eligible_at IS NOT NULL
            )::int AS deferred_segments,
            min(next_eligible_at) FILTER (
              WHERE status='pending'
                AND error_json->>'deferred_retry'='true'
            ) AS next_retry_at
           FROM source_backfill_segments
          WHERE plan_id=ANY($1::text[]) AND space_id=$2`,
        [backfillPlanIds, spaceId],
      );
      const now = new Date().toISOString();
      const segmentTotals = segmentProgress.rows[0] ?? {
        total_segments: 0,
        completed_segments: 0,
        failed_segments: 0,
        running_segments: 0,
        pending_segments: 0,
        deferred_segments: 0,
        next_retry_at: null,
      };
      const deferredPlans = plans.rows.filter(isDeferredBackfillPlan);
      const deferredSources = deferredPlans.map((plan) => {
        const error = objectValue(plan.error_json);
        const diagnostics = objectValue(error.diagnostics);
        return {
          provider_key: optionalString(diagnostics.provider_key),
          provider_display_name: optionalString(diagnostics.provider_display_name),
          upstream_status: typeof diagnostics.upstream_status === "number" ? diagnostics.upstream_status : null,
          automatic_attempts: typeof diagnostics.attempts === "number" ? diagnostics.attempts : 0,
          next_retry_at: optionalString(error.next_retry_at) ?? plan.next_eligible_at,
        };
      });
      state.backfill_progress = {
        total_segments: Number(segmentTotals.total_segments ?? 0),
        completed_segments: Number(segmentTotals.completed_segments ?? 0),
        failed_segments: Number(segmentTotals.failed_segments ?? 0),
        deferred_segments: Number(segmentTotals.deferred_segments ?? 0),
        running_segments: Number(segmentTotals.running_segments ?? 0),
        pending_segments: Number(segmentTotals.pending_segments ?? 0),
        items_ingested: plans.rows.reduce((sum, plan) => sum + Number(plan.items_ingested ?? 0), 0),
        next_retry_at: segmentTotals.next_retry_at,
        deferred_sources: deferredSources,
        plans: plans.rows.map((plan) => ({
          id: plan.id,
          status: plan.status,
          segments_total: Number(plan.segments_total ?? 0),
          segments_completed: Number(plan.segments_completed ?? 0),
          segments_failed: Number(plan.segments_failed ?? 0),
          items_ingested: Number(plan.items_ingested ?? 0),
          updated_at: plan.updated_at,
        })),
        updated_at: now,
      };
      const backfillDone = backfillCanProceed(plans.rows, backfillPlanIds.length);
      // Once the workflow has advanced past screening (synthesis, idea_review,
      // complete, failed, ...), this whole backfill->screening transition must
      // stay inert. Without this guard, backfillDone stays true forever (plans
      // never leave 'completed'), so every later reconcile tick would still
      // re-enter it, stomp current_stage back to "screening", and — since
      // createCheckpoint only recognizes a still-*pending* checkpoint as
      // "already exists" — mint a brand-new pending screening_gate checkpoint
      // even after the user already approved it and synthesis started. That is
      // exactly what "I approved the checkpoint but it came back after
      // refresh" looks like from the outside.
      // The stage alone is not enough: approving the gate does not move
      // `current_stage` out of "screening" until the next tick advances it, so
      // a reconcile racing that approval (the approval itself enqueues one)
      // would re-enter the transition and drag the operation back. The gate's
      // decision is the durable signal that screening is behind us.
      const screeningGateDecided = await this.db.query<{ id: string }>(
        `SELECT id FROM project_research_checkpoints
          WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3
            AND checkpoint_type='screening_gate'
            AND machine_result_json->>'operation_id'=$4
            AND status <> 'pending'
          LIMIT 1`,
        [spaceId, row.project_id, state.workflow_id, row.id],
      );
      const stillAtOrBeforeScreening = !screeningGateDecided.rows[0]
        && (state.current_stage === "backfill" || state.current_stage === "screening");
      if (backfillDone && stillAtOrBeforeScreening && !plans.rows.some((plan) => plan.status === "failed")) {
        state.coverage_degraded = deferredPlans.length > 0;
        // Keep the items-in-scope list and screening progress fresh on every
        // reconcile tick, independent of whether classification batches are
        // still running. isSourcePipelineDrained below only gates the stage
        // transition (finalizing coverage and creating the screening_gate
        // checkpoint) — without this, "Items classified"/"Batches" only ever
        // showed their pre-run (empty) and post-run (final) values, never
        // anything in between while batches were actually in flight.
        const sourceRecoveryPreview = new SourcePostProcessingRecoveryService(this.db);
        state.source_item_ids = await sourceRecoveryPreview.channelScopedItemIds(
          spaceId,
          state.channel_ids,
          unique([...state.source_item_ids, ...(await this.sourceItemsForBackfillPlans(spaceId, backfillPlanIds))]),
        );
        state.screening_progress = await this.screeningProgressFor(spaceId, row.project_id, row.id, state, row.created_at);
      }
      state.heartbeat_at = now;
      await this.setState(row, state, deriveStepStates(state));
      if (backfillDone && stillAtOrBeforeScreening) {
        if (plans.rows.some((plan) => plan.status === "failed")) {
          const failures = await this.db.query<FailedBackfillRow>(
            `SELECT p.id AS plan_id, s.id AS segment_id, p.source_channel_id,
                    COALESCE(ss.provider_key, provider.provider_key) AS provider_key,
                    provider.display_name AS provider_display_name,
                    s.attempt_count, s.error_json
               FROM source_backfill_segments s
               JOIN source_backfill_plans p ON p.id=s.plan_id AND p.space_id=s.space_id
               JOIN source_channels ch ON ch.id=p.source_channel_id AND ch.space_id=p.space_id
               JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id
               JOIN source_provider_connectors spc ON spc.id=sc.provider_connector_id
               JOIN source_providers provider ON provider.id=spc.provider_id
               LEFT JOIN source_search_specs ss ON ss.source_channel_id=ch.id AND ss.space_id=ch.space_id
              WHERE s.plan_id=ANY($1::text[]) AND s.space_id=$2 AND s.status='failed'
              ORDER BY p.id, s.seq`,
            [backfillPlanIds, spaceId],
          );
          const failure = summarizeBackfillFailures(failures.rows);
          await this.failOperation(row, failure.message, {
            code: failure.code,
            diagnostics: failure.diagnostics,
          });
          return;
        }
        if (!(await this.isSourcePipelineDrained(spaceId, state))) return;
        const partialSegment = await this.db.query<{ count: string }>(
          `SELECT count(*)::int AS count FROM source_backfill_segments
            WHERE plan_id=ANY($1::text[]) AND space_id=$2 AND window_json->>'partial'='true'
              AND COALESCE(window_json->>'exhausted','false') <> 'true'`,
          [backfillPlanIds, spaceId],
        );
        state.partial = Number(partialSegment.rows[0]?.count ?? 0) > 0;
        const sourceRecovery = new SourcePostProcessingRecoveryService(this.db);
        state.watermark = {
          ...state.watermark,
          after: await latestPublicationWatermarkForItems(this.db, {
            spaceId,
            sourceItemIds: state.source_item_ids,
          }),
        };
        state.current_stage = "screening";
        state.stage_state = "running";
        const preparation = await sourceRecovery.ensureItemsProcessed({
          spaceId,
          projectId: row.project_id,
          channelIds: state.channel_ids,
          ruleIds: unique([
            ...state.source_post_processing_rule_ids,
            ...(state.source_post_processing_rule_id ? [state.source_post_processing_rule_id] : []),
          ]),
          sourceItemIds: state.source_item_ids,
          operationId: row.id,
          recoveryRequestedAt: state.post_processing_recovery_requested_at,
          operationCreatedAt: row.created_at,
          researchQuestionVersion: state.research_question_version,
        });
        if (preparation.status === "failed") {
          await this.failOperation(row, preparation.message);
          return;
        }
        if (preparation.status === "waiting") {
          state.post_processing_recovery_requested_at = preparation.requestedAt;
          state.screening_progress = await this.screeningProgressFor(
            spaceId,
            row.project_id,
            row.id,
            state,
            row.created_at,
          );
          state.screening_progress = {
            ...state.screening_progress,
            started_at: preparation.requestedAt,
          };
          state.heartbeat_at = new Date().toISOString();
          await this.setState(row, state, deriveStepStates(state));
          return;
        }
        delete state.post_processing_recovery_requested_at;
        state.screening_progress = await this.screeningProgressFor(
          spaceId,
          row.project_id,
          row.id,
          state,
          row.created_at,
        );
        state.heartbeat_at = new Date().toISOString();
        if (state.run_kind === "historical_backfill") {
          const count = await this.countRelevantItems(spaceId, row.project_id, state.source_item_ids);
          if (count.relevant + count.maybe === 0) {
            state.current_stage = "complete";
            state.stage_state = "skipped";
            const completedState = withOperationCoverageStatus(state, row.id, state.partial ? "partial" : "completed");
            await this.setState(row, completedState, deriveSkippedAfterScreeningSteps());
            await this.completeWorkflowCoverage(spaceId, row.project_id, state.workflow_id, row.id, state.partial ? "partial" : "completed");
            await this.flushPendingIncremental(spaceId, row.project_id, state.workflow_id);
            await this.notifyRoomOfOperationStatus(row, "completed", "The research operation finished: no relevant material was found in the selected history window.");
          } else {
            await this.createScreeningGate(row, state);
          }
        } else {
          if (Number(state.screening_progress?.total_items ?? state.source_item_ids.length) === 0) {
            await this.completeEmptyInitialIntake(row, state);
          } else {
            await this.createScreeningGate(row, state);
          }
        }
      }
      return;
    }

    if ((state.run_kind === "incremental" || state.run_kind === "question_rescreen") && state.current_stage === "screening") {
      if (state.awaiting_source_scan && state.source_item_ids.length === 0) return;
      if (state.run_kind === "question_rescreen") {
        const preparation = await new SourcePostProcessingRecoveryService(this.db).ensureItemsProcessed({
          spaceId,
          projectId: row.project_id,
          channelIds: state.channel_ids,
          ruleIds: state.source_post_processing_rule_ids,
          sourceItemIds: state.source_item_ids,
          operationId: row.id,
          recoveryRequestedAt: state.post_processing_recovery_requested_at,
          operationCreatedAt: row.created_at,
          researchQuestionVersion: state.research_question_version,
        });
        if (preparation.status === "failed") {
          await this.failOperation(row, preparation.message);
          return;
        }
        if (preparation.status === "waiting") {
          state.post_processing_recovery_requested_at = preparation.requestedAt;
          state.screening_progress = await this.screeningProgressFor(spaceId, row.project_id, row.id, state, row.created_at);
          state.screening_progress.started_at = preparation.requestedAt;
          state.heartbeat_at = new Date().toISOString();
          await this.setState(row, state, deriveStepStates(state));
          return;
        }
        delete state.post_processing_recovery_requested_at;
      }
      state.screening_progress = await this.screeningProgressFor(
        spaceId,
        row.project_id,
        row.id,
        state,
        row.created_at,
      );
      state.heartbeat_at = new Date().toISOString();
      const count = await this.countRelevantItems(spaceId, row.project_id, state.source_item_ids);
      if (state.run_kind === "incremental") await this.recordScanSummary(row, state, count);
      if (count.relevant + count.maybe === 0) {
        state.current_stage = "complete";
        state.stage_state = "skipped";
        state.screening_progress = {
          ...state.screening_progress,
          phase: "completed",
          message: "No relevant or maybe material was found in this update.",
        };
        await this.setState(row, state, deriveSkippedAfterScreeningSteps());
        await this.notifyRoomOfOperationStatus(row, "completed", "The research operation finished: no relevant or maybe material was found in this update.");
      } else {
        await this.createScreeningGate(row, state);
      }
    }
  }

  private async reconcileMonitorSetup(row: OperationRow, state: ResearchOperationState): Promise<void> {
    const planIds = state.source_backfill_plan_ids?.length
      ? state.source_backfill_plan_ids
      : state.source_backfill_plan_id ? [state.source_backfill_plan_id] : [];
    const plans = await this.db.query<{ id: string }>(
      `SELECT id FROM source_backfill_plans
        WHERE space_id=$1
          AND (project_operation_id=$2 OR id=ANY($3::text[]))
        ORDER BY created_at ASC`,
      [row.space_id, row.id, planIds],
    );
    if (plans.rows.length === 0) return;

    const next = { ...state };
    next.source_backfill_plan_ids = unique(plans.rows.map((plan) => plan.id));
    next.source_backfill_plan_id = next.source_backfill_plan_ids[0] ?? null;
    next.current_stage = "backfill";
    next.stage_state = "running";
    await this.setState(row, next, deriveStepStates(next));
  }

  private async reconcileIdeaReviewStage(spaceId: string, row: OperationRow, state: ResearchOperationState): Promise<void> {
    const checkpoint = await this.db.query<{
      id: string;
      status: string;
      decided_by_user_id: string | null;
    }>(
      `SELECT id, status, decided_by_user_id
         FROM project_research_checkpoints
        WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3
          AND checkpoint_type='idea_review'
          AND machine_result_json->>'operation_id'=$4
          AND status IN ('approved','waived')
        ORDER BY updated_at DESC LIMIT 1`,
      [spaceId, row.project_id, state.workflow_id, row.id],
    );
    const value = checkpoint.rows[0];
    if (!value) return;
    const actorUserId = value.decided_by_user_id ?? await this.projectWriterActor(spaceId, row.project_id);
    if (!actorUserId) return;
    await this.resumeAfterCheckpoint(spaceId, actorUserId, row.project_id, state.workflow_id, value.id);
  }

  /**
   * A synthesis stage with no bound run can never progress: the stage
   * reconciler needs the run id, and nothing else re-queues. Every stage
   * writer binds the run in the same transition that enters synthesis, so
   * this state only appears when a binding write was lost. Adopt the newest
   * synthesis run recorded for this operation, or fail the operation into a
   * retryable state when none exists.
   */
  private recoverUnboundSynthesisStage(spaceId: string, row: OperationRow, state: ResearchOperationState): Promise<void> {
    return this.synthesisCoordinator().recoverUnbound(spaceId, row, state);
  }

  private reconcileSynthesisStage(spaceId: string, row: OperationRow, state: ResearchOperationState): Promise<void> {
    return this.synthesisCoordinator().reconcileStage(spaceId, row, state);
  }

  async reconcileRun(spaceId: string, runId: string): Promise<void> {
    const run = await this.db.query<{ contract_snapshot_json: unknown }>(
      `SELECT contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, spaceId],
    );
    const workflowInput = objectValue(objectValue(run.rows[0]?.contract_snapshot_json).workflow_input_json);
    if (workflowInput.research_adhoc) {
      await new ProjectResearchAreaService(this.db, this.config).applyAdhocRunOutput(spaceId, runId);
      return;
    }
    const contract = objectValue(workflowInput.project_research);
    const operationId = optionalString(contract.operation_id);
    if (!operationId) return;
    await this.reconcileOperation(spaceId, operationId);
  }

  async reconcileCompletedRun(spaceId: string, runId: string): Promise<void> {
    if (this.activePassExecutionId) {
      await this.applyCompletedRun(spaceId, runId);
      return;
    }
    const owner = await this.operationForResearchRun(spaceId, runId);
    if (!owner) return;
    const userId = await this.projectWriterActor(spaceId, owner.project_id);
    if (!userId) {
      await this.failOperation(owner, "Research run reconciliation requires a project writer");
      return;
    }
    await startResearchReconcilePass(
      this.db,
      { spaceId, userId },
      this.config,
      owner,
      "run_terminal",
      { kind: "run_terminal", runId },
    );
  }

  async executeCompletedRunPass(
    spaceId: string,
    runId: string,
    executionId: string,
  ): Promise<void> {
    this.activePassExecutionId = executionId;
    await this.applyCompletedRun(spaceId, runId);
  }

  private async applyCompletedRun(spaceId: string, runId: string): Promise<void> {
    const run = await this.db.query<{ id: string; project_id: string | null; instructed_by_user_id: string | null; status: string; output_json: unknown; contract_snapshot_json: unknown; error_message: string | null; error_json: unknown }>(
      `SELECT id, project_id, instructed_by_user_id, status, output_json, contract_snapshot_json, error_message, error_json FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, spaceId],
    );
    const row = run.rows[0];
    const contract = objectValue(objectValue(row?.contract_snapshot_json).workflow_input_json).project_research;
    if (!row || !row.project_id || !contract || typeof contract !== "object") return;
    const researchContract = objectValue(contract);
    const operationId = optionalString(researchContract.operation_id);
    const workflowId = optionalString(researchContract.workflow_id);
    const stageKey = optionalString(researchContract.stage_key);
    if (!operationId || !workflowId || !["monitor_compare", "synthesis", "synthesis_revision", "synthesis_critique"].includes(stageKey ?? "")) return;
    const operation = await this.operation(spaceId, operationId);
    if (!operation) return;
    if (
      this.activePassExecutionId
      && operation.current_execution_id !== this.activePassExecutionId
    ) {
      throw new HttpError(409, "Research run is not governed by this Workflow Execution");
    }
    if (!["succeeded", "degraded"].includes(row.status)) {
      const runError = objectValue(row.error_json);
      const detail = optionalString(row.error_message)
        ?? optionalString(runError.error_message)
        ?? optionalString(runError.message)
        ?? optionalString(runError.agent_run_error_code)
        ?? optionalString(runError.error_code);
      const runLabel = stageKey === "monitor_compare" ? "Monitoring comparison run" : "Synthesis agent run";
      await this.failOperation(operation, `${runLabel} ${row.status}${detail ? `: ${detail}` : " with no recorded error detail"}`);
      return;
    }

    if (stageKey === "monitor_compare") {
      const expected = Array.isArray(researchContract.source_item_ids)
        ? researchContract.source_item_ids.filter((item): item is string => typeof item === "string")
        : [];
      await this.monitoringCoordinator().reconcileCompletedComparison({
        spaceId,
        projectId: row.project_id,
        workflowId,
        operation,
        runId,
        instructedByUserId: row.instructed_by_user_id,
        output: row.output_json,
        expectedSourceItemIds: expected,
      });
      return;
    }

    if (stageKey === "synthesis_critique") {
      await this.reconcileCompletedCritique({
        spaceId,
        projectId: row.project_id,
        workflowId,
        operation,
        runId,
        userId: await this.projectWriterActor(spaceId, row.project_id),
        output: row.output_json,
      });
      return;
    }

    await this.synthesisCoordinator().reconcileCompletedDraft({
      spaceId, projectId: row.project_id, workflowId, operation, runId, output: row.output_json,
    });
  }

  private async reconcileCompletedCritique(input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    operation: OperationRow;
    runId: string;
    userId: string | null;
    output: unknown;
  }): Promise<void> {
    return this.synthesisCoordinator().reconcileCompletedCritique(input);
  }

  async resumeAfterCheckpoint(
    spaceId: string,
    userId: string,
    projectId: string,
    workflowId: string,
    checkpointId: string,
  ): Promise<void> {
    if (this.activePassExecutionId) {
      await this.executeCheckpointPass(
        spaceId,
        userId,
        projectId,
        workflowId,
        checkpointId,
        this.activePassExecutionId,
      );
      return;
    }
    const operation = await this.operationForCheckpoint(spaceId, projectId, checkpointId);
    if (!operation) return;
    await startResearchReconcilePass(
      this.db,
      { spaceId, userId },
      this.config,
      operation,
      "checkpoint_resume",
      { kind: "checkpoint_resume", userId, projectId, workflowId, checkpointId },
    );
  }

  async executeCheckpointPass(
    spaceId: string,
    userId: string,
    projectId: string,
    workflowId: string,
    checkpointId: string,
    executionId: string,
  ): Promise<void> {
    this.activePassExecutionId = executionId;
    const checkpoint = await this.db.query<{ checkpoint_type: string; status: string; machine_result_json: unknown; decided_by_user_id: string | null }>(
      `SELECT checkpoint_type, status, machine_result_json, decided_by_user_id FROM project_research_checkpoints WHERE id=$1 AND space_id=$2 AND project_id=$3 AND workflow_id=$4`,
      [checkpointId, spaceId, projectId, workflowId],
    );
    const value = checkpoint.rows[0];
    if (!value || !["approved", "waived"].includes(value.status)) return;
    const operationId = optionalString(objectValue(value.machine_result_json).operation_id);
    if (!operationId) return;
    const operation = await this.operation(spaceId, operationId);
    if (!operation) return;
    if (operation.current_execution_id !== executionId) {
      throw new HttpError(409, "Checkpoint is not governed by this Workflow Execution");
    }
    const state = researchState(operation.progress_json);
    if (value.checkpoint_type === "screening_gate") {
      const machineResult = objectValue(value.machine_result_json);
      const screeningTotal = typeof machineResult.total === "number" ? machineResult.total : null;
      if (screeningTotal === 0 && !state.synthesis_run_id) {
        throw new HttpError(409, "No material matched this search window; revise the search query or date range and rescan before continuing");
      }
      try {
        // A not-applied transition means the operation already moved past
        // screening (converged); reuseExistingRun re-enters a run bound by an
        // earlier clobbered pass instead of queueing a duplicate.
        if (state.run_kind === "incremental") {
          await this.queueMonitorComparison({ spaceId, userId, projectId, operationId: operation.id, workflowId });
        } else {
          await this.queueSynthesis({
            spaceId,
            userId,
            projectId,
            operationId: operation.id,
            workflowId,
            from: ["screening", "synthesis"],
            reuseExistingRun: true,
          });
        }
      } catch (error) {
        await this.failOperation(operation, error instanceof Error ? error.message : "Failed to queue synthesis run");
        throw error;
      }
      return;
    }
    if (value.checkpoint_type === "idea_review") {
      await new ProjectResearchReportStatusService(this.db).transitionForOperation(spaceId, operation.id, "complete");
      state.current_stage = "complete";
      state.stage_state = "succeeded";
      state.monitoring_active = true;
      const completedState = (state.run_kind === "baseline" || state.run_kind === "historical_backfill")
        ? withOperationCoverageStatus(state, operation.id, state.partial ? "partial" : "completed")
        : state;
      await this.setState(operation, completedState, [
        { seq: 0, status: "done" },
        { seq: 1, status: "done" },
        { seq: 2, status: "done" },
        { seq: 3, status: "done" },
        // Only a real decision is attributed. An auto-waived checkpoint has no
        // decider, and naming the project writer the pass happens to run under
        // would be the same false record `waiveCheckpointAutomatically`
        // avoids by leaving the column NULL.
        {
          seq: 4,
          status: "done",
          detail: value.decided_by_user_id
            ? { checkpoint_id: checkpointId, decided_by_user_id: value.decided_by_user_id }
            : { checkpoint_id: checkpointId, auto_continued: true },
        },
      ]);
      await this.setWorkflowMonitoring(spaceId, projectId, workflowId, state);
      await this.enqueueIntegrityMonitor(spaceId, userId, projectId, workflowId, "monitoring_activated");
      if (state.run_kind === "baseline") {
        await this.completeWorkflowCoverage(spaceId, projectId, workflowId, operation.id, state.partial ? "partial" : "completed");
      }
      if (state.run_kind === "historical_backfill") {
        await this.completeWorkflowCoverage(spaceId, projectId, workflowId, operation.id, state.partial ? "partial" : "completed");
        await this.flushPendingIncremental(spaceId, projectId, workflowId);
      }
      // A finished search changes what the pinned Thread should do next even
      // when it produced no material Signal of its own — and the Thread's
      // evidence-gathering step is finished because the search is, so the user
      // never has to come back and say so.
      await tryCompleteSearchStepForWorkflow(this.db, { spaceId, projectId, workflowId });
      await tryQueueAdviceForWorkflowThread(this.db, {
        spaceId, userId, projectId, workflowId, triggerKind: "search_completed",
      });
      await this.notifyRoomOfOperationStatus(
        operation,
        "completed",
        "The research operation finished. Its report, evidence, and any proposals are on the Project.",
      );
    }
  }

  async retryFailedOperation(identity: SpaceUserIdentity, projectId: string, operationId: string) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const operation = await this.operation(identity.spaceId, operationId);
    if (!operation || operation.project_id !== projectId) {
      throw new HttpError(404, "Research operation not found");
    }
    if (operation.status !== "failed") {
      throw new HttpError(409, "Only failed research operations can be retried");
    }
    await startResearchReconcilePass(
      this.db,
      identity,
      this.config,
      operation,
      "retry",
      { kind: "retry", userId: identity.userId, projectId },
    );
    return this.readOperation(identity, projectId, operationId);
  }

  async executeRetryPass(
    identity: SpaceUserIdentity,
    projectId: string,
    operationId: string,
    executionId: string,
  ) {
    this.activePassExecutionId = executionId;
    const operation = await this.operation(identity.spaceId, operationId);
    if (!operation || operation.current_execution_id !== executionId) {
      throw new HttpError(409, "Retry is not governed by this Workflow Execution");
    }
    return new ProjectResearchRetryService(this.db, {
      operation: (spaceId, id) => this.operation(spaceId, id),
      assertQuestionAligned: async (spaceId, id, workflowId) => {
        const workflow = workflowId ? await this.workflow(spaceId, id, workflowId) : null;
        await this.assertResearchQuestionAligned(spaceId, id, workflow?.state_json);
      },
      activeOperation: (spaceId, id, workflowId) => this.activeResearchOperation(spaceId, id, workflowId),
      retryMonitorSetup: (user, id, state) => this.retryMonitorSetup(user, id, state),
      ensureProcessingBatchSize: (user, ruleIds) => this.ensureResearchProcessingBatchSize(user, ruleIds),
      setState: (row, state) => this.setState(row, state, deriveStepStates(state)),
      enqueueReconcile: (spaceId, userId, id, reason) => this.enqueueReconcile(spaceId, userId, id, reason),
      failOperation: (row, message) => this.failOperation(row, message),
      readOperation: (user, id, operation) => this.readOperation(user, id, operation),
      queueSynthesis: (input) => this.queueSynthesis(input),
      queueComparison: (input) => this.queueMonitorComparison(input),
      retryBackfill: (spaceId, planId) => new SourceBackfillExecutionService(this.db).retry(spaceId, planId).then(() => undefined),
    }).retry(identity, projectId, operationId);
  }

  /**
   * Repair-only action for a stale operation projection. It observes the
   * canonical run and applies the normal reconciliation rules; it never
   * queues or re-executes a synthesis run.
   */
  async reconcileOperationForUser(identity: SpaceUserIdentity, projectId: string, operationId: string) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const operation = await this.operation(identity.spaceId, operationId);
    if (!operation || operation.project_id !== projectId) throw new HttpError(404, "Research operation not found");
    const beforeState = researchState(operation.progress_json);
    const boundRunId = beforeState.synthesis_run_id;
    const boundRun = boundRunId
      ? await this.db.query<{ status: string; updated_at: unknown }>(
        `SELECT status, updated_at FROM runs WHERE id=$1 AND space_id=$2`,
        [boundRunId, identity.spaceId],
      )
      : { rows: [] as Array<{ status: string; updated_at: unknown }> };
    const boundRunSnapshot = boundRun.rows[0] ?? null;
    await this.reconcileOperation(identity.spaceId, operation.id);
    let reconciled = await this.operation(identity.spaceId, operation.id);
    if (!reconciled) throw new HttpError(404, "Research operation disappeared during reconciliation");

    // A terminal canonical run must never leave its owning operation active.
    // If the normal artifact projection could not advance it, make the
    // failure explicit and retryable instead of returning another silent
    // synthesis state to the UI.
    const reconciledState = researchState(reconciled.progress_json);
    const terminalRun = boundRunSnapshot && ["succeeded", "degraded", "failed", "cancelled"].includes(boundRunSnapshot.status);
    if (
      terminalRun
      && reconciled.status === "active"
      && reconciledState.current_stage === "synthesis"
      && reconciledState.synthesis_run_id === boundRunId
    ) {
      await this.failOperation(reconciled, "The synthesis run is terminal but its result could not be applied to the research operation; retry synthesis", {
        code: "research_operation_reconcile_stuck",
        diagnostics: {
          operation_id: operation.id,
          run_id: boundRunId,
          run_status: boundRunSnapshot.status,
          run_updated_at: dateIso(boundRunSnapshot.updated_at),
          reconciliation: "terminal_run_active_operation_fallback",
        },
      });
      reconciled = await this.operation(identity.spaceId, operation.id);
      if (!reconciled) throw new HttpError(404, "Research operation disappeared after reconciliation fallback");
    }

    const result = await this.readOperation(identity, projectId, operation.id);
    return {
      ...result,
      reconcile_diagnostic: {
        operation_id: operation.id,
        bound_run_id: boundRunId,
        bound_run_status: boundRunSnapshot?.status ?? null,
        before_status: operation.status,
        after_status: reconciled.status,
        after_stage: researchState(reconciled.progress_json).current_stage,
      },
    };
  }

  /**
   * Updates the saved intake limit without requiring the rest of the intake
   * setup. Project Settings owns this value independently; the research
   * question and source monitors are only required when the user starts the
   * intake.
   */
  async updateInitialItemLimit(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, (db) =>
      new ProjectResearchOrchestrator(db, this.config).updateInitialItemLimitLocked(identity, projectId, body),
    );
  }

  private async updateInitialItemLimitLocked(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const requestedWorkflowId = optionalString(body.workflow_id);
    const requestedLimit = Number(body.max_items);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_ITEMS_DEFAULT) {
      throw new HttpError(422, `max_items must be an integer between 1 and ${MAX_ITEMS_DEFAULT}`);
    }
    const existing = requestedWorkflowId
      ? await this.workflow(identity.spaceId, projectId, requestedWorkflowId, true, true)
      : null;
    if (requestedWorkflowId && !existing) throw new HttpError(404, "Research workflow not found");
    const now = new Date().toISOString();
    const current = existing;
    if (current) {
      const operation = await this.db.query<{ id: string }>(
        `SELECT id FROM project_operations
          WHERE space_id=$1 AND project_id=$2 AND kind='research'
            AND progress_json->>'workflow_id'=$3
            AND status IN ('draft','active','waiting_review')
            AND progress_json->>'run_kind' IN ('baseline','historical_backfill')
          ORDER BY updated_at DESC LIMIT 1`,
        [identity.spaceId, projectId, current.id],
      );
      if (operation.rows[0]) {
        throw new HttpError(409, "An active Project Research operation owns the item limit");
      }
      const state = objectValue(current.state_json);
      const initialIntake = objectValue(state.initial_intake);
      const nextState = {
        ...state,
        initial_intake: { ...initialIntake, max_items: requestedLimit },
      };
      await this.db.query(
        `WITH changed AS (UPDATE project_research_workflows SET state_json=$4::jsonb
          WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
         UPDATE space_objects object SET updated_at=$5 FROM changed
          WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
        [identity.spaceId, projectId, current.id, JSON.stringify(nextState), now],
      );
      const workflow = await this.workflow(identity.spaceId, projectId, current.id);
      if (!workflow) throw new HttpError(500, "Failed to update the research item limit");
      return workflowOutput(workflow);
    }

    const id = randomUUID();
    const state = {
      schema_version: "project_research_initial_intake.v1",
      initial_intake: { max_items: requestedLimit },
      draft: { status: "partial", saved_at: now },
    };
    await createResearchWorkflow(this.db, {
      id, spaceId: identity.spaceId, projectId, title: "Research workflow",
      status: "not_started", currentStage: "initial_intake_setup", state,
      startedByUserId: identity.userId, now,
    });
    const workflow = await this.workflow(identity.spaceId, projectId, id);
    if (!workflow) throw new HttpError(500, "Failed to save the research item limit");
    return workflowOutput(workflow);
  }

  /**
   * Changes the effective research item limit only from the explicit Project
   * Settings action. Recovery actions such as rescan never choose or add a
   * budget on their own.
   */
  async updateItemLimit(identity: SpaceUserIdentity, projectId: string, operationId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, (db) =>
      new ProjectResearchOrchestrator(db, this.config).updateItemLimitLocked(identity, projectId, operationId, body),
    );
  }

  private async updateItemLimitLocked(identity: SpaceUserIdentity, projectId: string, operationId: string, body: Record<string, unknown>) {
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const requestedLimit = Number(body.max_items);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_ITEMS_DEFAULT) {
      throw new HttpError(422, `max_items must be an integer between 1 and ${MAX_ITEMS_DEFAULT}`);
    }
    const operation = await this.operation(identity.spaceId, operationId);
    if (!operation || operation.project_id !== projectId) throw new HttpError(404, "Research operation not found");
    const state = researchState(operation.progress_json);
    if (state.run_kind !== "baseline" && state.run_kind !== "historical_backfill") {
      throw new HttpError(409, "Only material backfill operations have an item limit");
    }
    const planIds = state.source_backfill_plan_ids?.length
      ? state.source_backfill_plan_ids
      : state.source_backfill_plan_id ? [state.source_backfill_plan_id] : [];
    const currentLimit = state.history?.max_items;
    if (typeof currentLimit !== "number" || !Number.isInteger(currentLimit) || currentLimit < 1) {
      throw new HttpError(409, "This operation has no recorded item limit");
    }
    if (requestedLimit < currentLimit) {
      throw new HttpError(409, "An active research item limit can only be increased");
    }
    if (requestedLimit === currentLimit) return this.readOperation(identity, projectId, operation.id);

    // A monitor_setup operation has already captured the limit, but may not
    // have created plans yet (for example after a setup failure). Updating
    // that snapshot must still be independent of the question/source setup;
    // the next setup/retry pass will use the new explicit limit.
    if (planIds.length === 0) {
      const setupStage = state.failed_stage ?? state.current_stage;
      if (setupStage !== "monitor_setup") throw new HttpError(409, "This operation has no backfill plans");
      state.history = { ...(state.history ?? { mode: null, from: null, to: null, max_items: null }), max_items: requestedLimit };
      await this.setState(operation, state, deriveStepStates(state));
      return this.readOperation(identity, projectId, operation.id);
    }

    const additionalItems = requestedLimit - currentLimit;
    const wasPartial = state.partial;
    state.history = { ...(state.history ?? { mode: null, from: null, to: null, max_items: null }), max_items: requestedLimit };
    state.partial = false;
    state.current_stage = "backfill";
    state.stage_state = "running";
    delete state.failed_stage;
    await this.waivePendingScreeningCheckpoint(identity, projectId, state.workflow_id, operation.id, "Superseded by item limit update");
    await this.setState(operation, state, deriveStepStates(state));
    const execution = new SourceBackfillExecutionService(this.db);
    if (wasPartial) {
      if (!state.source_backfill_plan_id) throw new HttpError(409, "This partial operation has no resumable backfill plan");
      await execution.continuePartial(identity.spaceId, state.source_backfill_plan_id, additionalItems);
    } else {
      for (const planId of planIds) await execution.rescanZeroYield(identity.spaceId, planId, 0);
    }
    await this.enqueueReconcile(identity.spaceId, identity.userId, operation.id, "item_limit_update");
    return this.readOperation(identity, projectId, operation.id);
  }

  /**
   * Re-runs zero-yield windows against the monitor's current query. This is a
   * query-recovery action only; it never changes the operation's item budget.
   * Any budget change must go through updateItemLimit, which is the explicit
   * Project Settings path.
   */
  async rescanEmptyBackfill(identity: SpaceUserIdentity, projectId: string, operationId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const operation = await this.operation(identity.spaceId, operationId);
    if (!operation || operation.project_id !== projectId) throw new HttpError(404, "Research operation not found");
    const state = researchState(operation.progress_json);
    await this.assertResearchQuestionAligned(identity.spaceId, projectId, state.workflow_id ? (await this.workflow(identity.spaceId, projectId, state.workflow_id))?.state_json : null);
    if (!(state.run_kind === "baseline" || state.run_kind === "historical_backfill")) {
      throw new HttpError(409, "Only a material intake or historical backfill operation can be rescanned");
    }
    if (state.partial) {
      throw new HttpError(409, "This partial backfill must be resumed by increasing the item limit in Project Settings");
    }
    const stage = state.failed_stage ?? state.current_stage;
    if (stage === "monitor_setup") {
      throw new HttpError(409, "This operation hasn't started importing material yet");
    }
    const active = await this.activeResearchOperation(identity.spaceId, projectId, state.workflow_id);
    if (active && active.id !== operation.id) throw new HttpError(409, "Another Project Research operation is already active for this workflow");
    const additionalItems = body.additional_max_items === undefined ? 0 : Number(body.additional_max_items);
    if (!Number.isInteger(additionalItems) || additionalItems < 0 || additionalItems > MAX_ITEMS_DEFAULT) {
      throw new HttpError(422, `additional_max_items must be an integer between 0 and ${MAX_ITEMS_DEFAULT}`);
    }
    if (additionalItems > 0) {
      throw new HttpError(409, "Changing the item limit is only available from Project Settings");
    }
    const planIds = state.source_backfill_plan_ids?.length ? state.source_backfill_plan_ids : state.source_backfill_plan_id ? [state.source_backfill_plan_id] : [];
    if (planIds.length === 0) throw new HttpError(409, "This operation has no backfill plans to rescan");
    await this.waivePendingScreeningCheckpoint(identity, projectId, state.workflow_id, operation.id, "Superseded by rescan");
    state.partial = false;
    state.current_stage = "backfill";
    state.stage_state = "running";
    delete state.failed_stage;
    await this.setState(operation, state, deriveStepStates(state));
    const execution = new SourceBackfillExecutionService(this.db);
    for (const planId of planIds) await execution.rescanZeroYield(identity.spaceId, planId, 0);
    await this.enqueueReconcile(identity.spaceId, identity.userId, operation.id, "rescan_zero_yield");
    return this.readOperation(identity, projectId, operation.id);
  }

  async reconcileAll(spaceId: string): Promise<number> {
    const operations = await this.db.query<{ id: string }>(
      `SELECT id FROM project_operations WHERE space_id=$1 AND kind='research' AND status IN ('active','waiting_review') ORDER BY updated_at ASC LIMIT 100`,
      [spaceId],
    );
    for (const operation of operations.rows) await this.reconcileOperation(spaceId, operation.id);
    return operations.rows.length;
  }

  async onPostProcessingRecoveryStarted(input: { spaceId: string; operationId: string }): Promise<void> {
    await this.enqueueReconcile(input.spaceId, null, input.operationId, "post_processing_recovery_started");
  }

  async onPostProcessingSucceeded(input: {
    spaceId: string;
    projectId: string | null;
    sourcePostProcessingRunId: string;
    userId: string | null;
  }): Promise<void> {
    if (!input.projectId) return;
    await this.enqueueReconcile(input.spaceId, input.userId, null, "post_processing_succeeded", {
      source_post_processing_run_id: input.sourcePostProcessingRunId,
    });
  }

  async reconcilePostProcessingRun(spaceId: string, runId: string): Promise<void> {
    await withQueryableTransaction(this.db, (db) =>
      new ProjectResearchOrchestrator(db, this.config).reconcilePostProcessingRunLocked(spaceId, runId));
  }

  private async reconcilePostProcessingRunLocked(spaceId: string, runId: string): Promise<void> {
    return this.monitoringCoordinator().reconcilePostProcessingRun(spaceId, runId);
  }

  async onPostProcessingRecoveryFinished(input: { spaceId: string; operationId: string }): Promise<void> {
    await this.enqueueReconcile(input.spaceId, null, input.operationId, "post_processing_recovery_finished");
  }

  private async startInitialIntakeLocked(identity: SpaceUserIdentity, projectId: string, input: ResearchInput) {
    if (!input.queryStrategyId) throw new HttpError(422, "query_strategy_id is required");
    const discovery = await this.initialIntakeCoordinator().resolveDiscovery(identity, projectId, input.queryStrategyId);
    input = {
      ...input,
      researchQuestion: discovery.question,
      sourceChannelIds: discovery.sourceChannelIds,
      researchScope: discovery.scope,
    };
    const threadScope = await resolveResearchThreadScope(
      this.db,
      identity,
      projectId,
      input.researchQuestion,
      input.requestedThreadId,
    );
    input = { ...input, researchQuestion: threadScope.statement, threadScope: [threadScope] };
    // Serialize the idempotency lookup and Thread-owned Workflow resolution.
    // Without the Project row lock, two concurrent starts can both observe no
    // matching Workflow before either inserts one.
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const existing = await this.db.query<{ id: string; progress_json: unknown }>(
      `SELECT id, progress_json FROM project_operations WHERE space_id=$1 AND project_id=$2 AND kind='research' AND progress_json->'idempotency'->>'key'=$3 ORDER BY created_at LIMIT 1`,
      [identity.spaceId, projectId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const prior = researchState(existing.rows[0].progress_json);
      const retryableSourceSetup = prior.run_kind === "baseline"
        && prior.failed_stage === "monitor_setup"
        && (await this.operation(identity.spaceId, existing.rows[0].id))?.status === "failed";
      if (!retryableSourceSetup) {
        if (prior.idempotency.fingerprint !== initialIntakeFingerprint(input)) {
          throw new HttpError(409, "idempotency_key is already used with different research parameters");
        }
        return this.startResponse(identity, projectId, existing.rows[0].id);
      }
      input = { ...input, idempotencyKey: `${input.idempotencyKey}:retry:${randomUUID()}` };
    }
    const fingerprint = initialIntakeFingerprint(input);

    const workflow = await this.createOrReuseWorkflow(identity.spaceId, projectId, identity.userId, input);
    if (!workflow) throw new HttpError(500, "Failed to create research workflow");
    await this.db.query(
      `SELECT object_id FROM project_research_workflows WHERE space_id=$1 AND project_id=$2 AND object_id=$3 FOR UPDATE`,
      [identity.spaceId, projectId, workflow.id],
    );
    const active = await this.activeResearchOperation(identity.spaceId, projectId, workflow.id);
    if (active) throw new HttpError(409, "Another Project Research operation is already active for this workflow");
    if (objectValue(objectValue(workflow.state_json).monitoring).active === true) {
      throw new HttpError(409, "This Project Research workflow already has an active initial material intake");
    }
    const workflowStartedAt = new Date().toISOString();
    await this.db.query(
      `WITH changed AS (UPDATE project_research_workflows
          SET state_json=COALESCE(state_json,'{}'::jsonb) || $4::jsonb,status='active'
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
       UPDATE space_objects object SET updated_at=$5,title=$6 FROM changed
        WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
      [identity.spaceId, projectId, workflow.id, JSON.stringify({
        research_question: input.researchQuestion,
        thread_scope: input.threadScope,
        source_channel_ids: input.sourceChannelIds,
        query_strategy_id: input.queryStrategyId,
        research_scope: input.researchScope,
      }), workflowStartedAt, input.researchQuestion.slice(0, 512)],
    );
    const operation = await this.createOperation(identity, projectId, {
      title: "Start initial material intake",
      intentText: `Initialize research workflow for: ${input.researchQuestion}`,
      steps: operationSteps(),
      state: initialState(input, workflow.id, fingerprint),
    });
    const { channels, bindings, rules, plans } = await this.initialIntakeCoordinator().provisionBackfills(
      identity,
      projectId,
      operation.id,
      input.sourceChannelIds,
      input,
    );
    const binding = bindings[0]!;
    const rule = rules[0]!;
    const state = researchState(operation.progress_json);
    state.channel_ids = channels.map((channel) => String(channel.id));
    state.project_source_binding_ids = bindings.map((row) => String(row.id));
    state.source_post_processing_rule_ids = rules.map((row) => String(row.id));
    state.project_source_binding_id = String(binding.id);
    state.source_post_processing_rule_id = String(rule.id);
    state.source_backfill_plan_ids = plans.map((plan) => String(plan.id));
    state.source_backfill_plan_id = state.source_backfill_plan_ids[0] ?? null;
    state.coverage_ranges = [{ from: input.from!, to: input.to!, operation_id: operation.id, status: "pending" }];
    state.current_stage = "backfill";
    state.stage_state = "running";
    await this.setState(operation, state, [
      { seq: 0, status: "done", detail: { channel_ids: state.channel_ids, binding_ids: state.project_source_binding_ids, rule_ids: state.source_post_processing_rule_ids } },
      { seq: 1, status: "active", detail: { plan_ids: state.source_backfill_plan_ids, authorization: "explicit_user_start" } },
      { seq: 2, status: "pending" },
      { seq: 3, status: "pending" },
      { seq: 4, status: "pending" },
    ]);
    await this.db.query(
      `WITH changed AS (UPDATE project_research_workflows
          SET state_json = COALESCE(state_json, '{}'::jsonb) || $4::jsonb
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
       UPDATE space_objects object SET updated_at=$5 FROM changed
        WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
      [identity.spaceId, projectId, workflow.id, JSON.stringify({
        channel_ids: state.channel_ids,
        project_source_binding_id: state.project_source_binding_id,
        source_post_processing_rule_id: state.source_post_processing_rule_id,
        source_backfill_plan_id: state.source_backfill_plan_id,
        source_backfill_plan_ids: state.source_backfill_plan_ids,
        agent_id: state.agent_id,
        runtime_profile_id: state.runtime_profile_id,
        report_depth: state.report_depth,
        question_refine_skipped: state.question_refine_skipped,
        research_scope: input.researchScope,
        initial_intake: { ...objectValue(objectValue(workflow.state_json).initial_intake), history_mode: input.historyMode, from: input.from, to: input.to },
        coverage_ranges: [{ from: input.from, to: input.to, operation_id: operation.id, status: "pending" }],
      }), new Date().toISOString()],
    );
    await new ProjectOperationService(this.db).link(identity.spaceId, projectId, operation.id, "research_workflow", workflow.id, "workflow_definition");
    await new ProjectOperationService(this.db).link(identity.spaceId, projectId, operation.id, "project_source_binding", String(binding.id), "source_binding");
    for (let index = 0; index < plans.length; index += 1) {
      await new ProjectOperationService(this.db).link(identity.spaceId, projectId, operation.id, "source_backfill_plan", String(plans[index]!.id), "history_backfill");
    }
    // The Inquiry step becomes a background acquisition only after both the
    // Workflow and its first Operation exist. Merely opening setup must never
    // claim that a search is running.
    await new InquiryIterationService(this.db).updateWork(
      identity,
      projectId,
      threadScope.thread_id,
      { attention_state: "focused", next_focus_kind: "search_acquisition", blocked_reason: null },
    );
    return this.startResponse(identity, projectId, operation.id);
  }

  private initialIntakeCoordinator(): ProjectResearchInitialIntakeCoordinator {
    return new ProjectResearchInitialIntakeCoordinator(this.db, this.config);
  }

  private ensureResearchProcessingBatchSize(identity: SpaceUserIdentity, ruleIds: string[]): Promise<void> {
    return this.initialIntakeCoordinator().ensureProcessingBatchSize(identity, ruleIds);
  }

  private async retryMonitorSetup(
    identity: SpaceUserIdentity,
    projectId: string,
    state: ResearchOperationState,
  ) {
    const workflow = await this.workflow(identity.spaceId, projectId, state.workflow_id);
    if (!workflow) throw new HttpError(404, "Research workflow not found");
    const workflowState = objectValue(workflow.state_json);
    const historyMode = state.history.mode ?? "bounded_range";
    if (historyMode === "bounded_range" && (!state.history.from || !state.history.to)) {
      throw new HttpError(409, "The failed initial material intake is missing its historical range and cannot be retried");
    }
    const input: ResearchInput = {
      workflowId: workflow.id,
      researchQuestion: optionalString(workflowState.research_question) ?? "Project research",
      requestedThreadId: state.thread_scope[0]?.thread_id ?? null,
      threadScope: state.thread_scope,
      sourceChannelIds: state.channel_ids,
      historyMode,
      from: state.history.from,
      to: state.history.to,
      maxItems: state.history.max_items ?? MAX_ITEMS_DEFAULT,
      monitoringField: state.query.sort_by === "lastUpdatedDate" ? "lastUpdatedDate" : "submittedDate",
      schedule: "daily",
      agentId: state.agent_id,
      runtimeProfileId: state.runtime_profile_id,
      execution: {},
      idempotencyKey: `${state.idempotency.key}:retry:${randomUUID()}`,
      reportDepth: state.report_depth,
      questionRefineSkipped: state.question_refine_skipped,
      queryStrategyId: optionalString(workflowState.query_strategy_id),
      researchScope: normalizeResearchScope(state.research_scope ?? workflowState.research_scope),
    };
    return this.startInitialIntakeLocked(identity, projectId, input);
  }

  private async createOperation(identity: SpaceUserIdentity, projectId: string, input: { title: string; intentText: string; steps: string[]; state: ResearchOperationState }) {
    const derived = deriveStepStates(input.state);
    const created = await new ProjectOperationService(this.db).createManagedResearch(identity, projectId, {
      title: input.title,
      intentText: input.intentText,
      status: input.state.stage_state === "waiting_review" ? "waiting_review" : "active",
      progress: input.state as unknown as Record<string, unknown>,
      steps: input.steps.map((title, seq) => {
        const projected = derived.find((step) => step.seq === seq);
        return { title, status: projected?.status ?? "pending" };
      }),
    });
    const operation = await this.operation(identity.spaceId, String(created.id));
    if (!operation) throw new HttpError(500, "Failed to create project research operation");
    return operation;
  }

  private async createOrReuseWorkflow(spaceId: string, projectId: string, userId: string, input: ResearchInput) {
    const primaryThreadId = input.threadScope[0]?.thread_id;
    if (!primaryThreadId) throw new HttpError(422, "A research Thread scope is required");
    if (input.workflowId) {
      const workflow = await this.workflow(spaceId, projectId, input.workflowId, false, true);
      if (!workflow) throw new HttpError(404, "Research workflow not found");
      if (!["active", "paused", "not_started"].includes(workflow.status)) {
        throw new HttpError(409, "This research workflow can no longer be started");
      }
      if (workflow.primary_thread_id !== primaryThreadId) {
        throw new HttpError(409, "The selected research workflow belongs to a different Inquiry Thread");
      }
      return workflow;
    }
    const existing = await this.workflowByThread(spaceId, projectId, primaryThreadId, false);
    if (existing && ["active", "paused", "not_started"].includes(existing.status)) return existing;
    if (existing) throw new HttpError(409, "This Inquiry Thread already has a completed research workflow; open its operation or rescan it instead");
    const id = randomUUID();
    const now = new Date().toISOString();
    const state = {
      research_question: input.researchQuestion,
      research_question_version: 1,
      thread_scope: input.threadScope,
      source_channel_ids: input.sourceChannelIds,
      agent_id: input.agentId,
      runtime_profile_id: input.runtimeProfileId,
      report_depth: input.reportDepth,
      question_refine_skipped: input.questionRefineSkipped,
      query_strategy_id: input.queryStrategyId,
      research_scope: input.researchScope,
      initial_intake: { history_mode: input.historyMode, from: input.from, to: input.to, max_items: input.maxItems },
      coverage_ranges: [],
      monitoring: { field: input.monitoringField, schedule: input.schedule, overlap_hours: OVERLAP_HOURS, active: false },
    };
    await createResearchWorkflow(this.db, {
      id, spaceId, projectId, title: input.researchQuestion, status: "active", state,
      startedByUserId: userId, primaryThreadId, now,
    });
    const workflow = await this.workflow(spaceId, projectId, id);
    if (!workflow) throw new HttpError(500, "Failed to create research workflow");
    return workflow;
  }

  /**
   * Queue (or re-attach to) the synthesis agent run for an operation.
   *
   * The stage transition, the run row, its agent_run job, and the state that
   * binds them all commit in one transaction, and every decision is made
   * against the freshly locked operation state: a transition that does not
   * apply creates nothing, and an applied transition can never leave an
   * unbound run behind. `from` scopes the stages the caller may queue from;
   * `reuseExistingRun` re-enters a still-bound run instead of queueing a
   * duplicate.
   */
  private async queueMonitorComparison(input: {
    spaceId: string;
    userId: string;
    projectId: string;
    operationId: string;
    workflowId: string;
  }): Promise<ResearchMutationResult> {
    return this.monitoringCoordinator().queueComparison(input);
  }

  private async reconcileComparisonStage(spaceId: string, row: OperationRow, state: ResearchOperationState): Promise<void> {
    return this.monitoringCoordinator().reconcileComparisonStage(spaceId, row, state);
  }

  private queueSynthesis(input: QueueSynthesisInput): Promise<ResearchMutationResult> {
    return this.synthesisCoordinator().queue(input);
  }

  private synthesisCoordinator(): ProjectResearchSynthesisCoordinator {
    return new ProjectResearchSynthesisCoordinator(this.db, {
      operation: (spaceId, operationId) => this.operation(spaceId, operationId),
      setWorkflowMonitoring: (spaceId, projectId, workflowId, state) =>
        this.setWorkflowMonitoring(spaceId, projectId, workflowId, state),
      failOperation: (operation, message, details) => this.failOperation(operation, message, details),
      projectWriterActor: (spaceId, projectId) => this.projectWriterActor(spaceId, projectId),
      reconcileCompletedRun: (spaceId, runId) => this.reconcileCompletedRun(spaceId, runId),
      createCheckpoint: (db, spaceId, projectId, workflowId, operationId, type, result) =>
        new ProjectResearchOrchestrator(db, this.config)
          .createCheckpoint(spaceId, projectId, workflowId, operationId, type, result),
    });
  }

  private screeningCoordinator(): ProjectResearchScreeningCoordinator {
    return new ProjectResearchScreeningCoordinator(this.db, {
      createCheckpoint: (spaceId, projectId, workflowId, operationId, type, result) =>
        this.createCheckpoint(spaceId, projectId, workflowId, operationId, type, result),
      setState: (operation, state, steps) => this.setState(operation, state, steps),
      resumeAfterCheckpoint: async (operation, workflowId, checkpointId) => {
        const actorUserId = await this.projectWriterActor(operation.space_id, operation.project_id);
        if (!actorUserId) {
          // Loud, like `reconcileOperation` in the same condition. A silent
          // return here would strand the operation: the gate is already
          // waived, so the screening transition never re-enters, and without
          // a `failed` status there is nothing to retry.
          await this.failScreeningOperation(operation.space_id, operation.id, "Research auto-continue requires a project writer");
          return;
        }
        await this.resumeAfterCheckpoint(
          operation.space_id,
          actorUserId,
          operation.project_id,
          workflowId,
          checkpointId,
        );
      },
      notifyRoom: (operation, status, reason) =>
        this.notifyRoomOfOperationStatus(operation as OperationRow, status, reason),
      failOperation: (operation, message) =>
        this.failScreeningOperation(operation.space_id, operation.id, message),
    });
  }

  /** Screening-port failure entry: refetches the full row (the coordinator's
   * `ScreeningOperationRow` carries no `status`, which `failOperation`'s
   * terminal guard reads) and fails through the single failure path. */
  private async failScreeningOperation(spaceId: string, operationId: string, message: string): Promise<void> {
    const row = await this.operation(spaceId, operationId);
    if (!row) return;
    await this.failOperation(row, message);
  }

  private createScreeningGate(operation: OperationRow, state: ResearchOperationState): Promise<void> {
    return this.screeningCoordinator().createGate(operation, state);
  }

  private completeEmptyInitialIntake(operation: OperationRow, state: ResearchOperationState): Promise<void> {
    return this.screeningCoordinator().completeEmptyInitialIntake(operation, state);
  }

  private async createCheckpoint(spaceId: string, projectId: string, workflowId: string, operationId: string, type: string, result: Record<string, unknown>): Promise<string> {
    return upsertPendingResearchCheckpoint(this.db, {
      spaceId,
      projectId,
      workflowId,
      operationId,
      checkpointType: type,
      machineResult: result,
    });
  }

  private countRelevantItems(spaceId: string, projectId: string, sourceItemIds: string[]) {
    return this.screeningCoordinator().countRelevantItems(spaceId, projectId, sourceItemIds);
  }

  private async recordScanSummary(
    operation: Pick<OperationRow, "id" | "space_id" | "project_id">,
    state: ResearchOperationState,
    counts: { relevant: number; maybe: number; excluded: number },
  ): Promise<void> {
    return this.monitoringCoordinator().recordScanSummary(operation, state, counts);
  }

  private monitoringCoordinator(): ProjectResearchMonitoringCoordinator {
    return new ProjectResearchMonitoringCoordinator(this.db, this.config, {
      projectWriterActor: (spaceId, projectId) => this.projectWriterActor(spaceId, projectId),
      screeningProgressFor: (spaceId, projectId, operationId, state, createdAt) =>
        this.screeningProgressFor(spaceId, projectId, operationId, state, createdAt),
      hasResearchQuestionDrift: (spaceId, projectId, workflow) =>
        this.hasResearchQuestionDrift(spaceId, projectId, workflow),
      appendPendingIncrementalItems: (spaceId, projectId, workflowId, itemIds) =>
        this.appendPendingIncrementalItems(spaceId, projectId, workflowId, itemIds),
      reconcileOperation: (spaceId, operationId) => this.reconcileOperation(spaceId, operationId),
      startEmptyScanPass: (input, operationId) =>
        this.startEmptyScanPass(input, operationId),
      activeHistoricalBackfill: (spaceId, projectId, workflowId) =>
        this.activeHistoricalBackfill(spaceId, projectId, workflowId),
      backfillPlanForItems: (spaceId, itemIds) => this.backfillPlanForItems(spaceId, itemIds),
      operationByIdempotency: (spaceId, projectId, key) => this.operationByIdempotency(spaceId, projectId, key),
      activeIncremental: (spaceId, projectId, workflowId) => this.activeIncremental(spaceId, projectId, workflowId),
      createIncrementalOperation: ({ identity, projectId, workflowState, workflowId, sourceItemIds, idempotencyKey, watermarkAfter }) =>
        this.createOperation(identity, projectId, {
          title: "Process new research items",
          intentText: "Prepare a human-reviewed incremental research update.",
          steps: operationSteps(),
          state: incrementalStateFromWorkflow(workflowState, workflowId, unique(sourceItemIds), idempotencyKey, {
            before: optionalString(objectValue(objectValue(workflowState).monitoring).watermark_after),
            after: watermarkAfter,
            overlap_hours: OVERLAP_HOURS,
          }),
        }),
      operation: (spaceId, operationId) => this.operation(spaceId, operationId),
      failOperation: (operation, message) => this.failOperation(operation, message),
      setWorkflowMonitoring: (spaceId, projectId, workflowId, state) =>
        this.setWorkflowMonitoring(spaceId, projectId, workflowId, state),
      reconcileCompletedRun: (spaceId, runId) => this.reconcileCompletedRun(spaceId, runId),
      enqueueIntegrityMonitor: (spaceId, userId, projectId, workflowId, reason) =>
        this.enqueueIntegrityMonitor(spaceId, userId, projectId, workflowId, reason),
    });
  }

  private isSourcePipelineDrained(spaceId: string, state: ResearchOperationState): Promise<boolean> {
    return this.screeningCoordinator().isSourcePipelineDrained(spaceId, state);
  }

  private screeningProgressFor(
    spaceId: string,
    projectId: string,
    operationId: string,
    state: ResearchOperationState,
    operationCreatedAt?: string,
  ): Promise<NonNullable<ResearchOperationState["screening_progress"]>> {
    return this.screeningCoordinator().progressFor(spaceId, projectId, operationId, state, operationCreatedAt);
  }

  private async projectWriterActor(spaceId: string, projectId: string): Promise<string | null> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT owner_user_id AS user_id FROM projects WHERE space_id=$1 AND id=$2 AND owner_user_id IS NOT NULL
       UNION ALL
       SELECT user_id FROM space_memberships WHERE space_id=$1 AND role IN ('owner','admin') AND status='active'
       ORDER BY user_id LIMIT 1`,
      [spaceId, projectId],
    );
    return result.rows[0]?.user_id ?? null;
  }

  private async setWorkflowMonitoring(spaceId: string, projectId: string, workflowId: string, state: ResearchOperationState): Promise<void> {
    // jsonb_set silently no-ops when an intermediate path key is missing, and
    // reused workflows (created by draft/item-limit paths) may have no
    // `monitoring` object at all — merge with || so the object is created.
    const workflowUpdatedAt = new Date().toISOString();
    await this.db.query(
      `WITH changed AS (UPDATE project_research_workflows
          SET state_json=COALESCE(state_json,'{}'::jsonb) || jsonb_build_object(
                'monitoring',
                COALESCE(state_json->'monitoring','{}'::jsonb) || jsonb_build_object(
                  'active', true,
                  'channel_ids', $4::jsonb,
                  'watermark_after', $5::jsonb
                )
              )
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
       UPDATE space_objects object SET updated_at=$6 FROM changed
        WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
      [
        spaceId,
        projectId,
        workflowId,
        JSON.stringify(state.channel_ids),
        JSON.stringify(state.watermark.after),
        workflowUpdatedAt,
      ],
    );
    for (const channelId of state.channel_ids ?? []) {
      const now = new Date().toISOString();
      const channel = await this.db.query<{
        id: string;
        space_id: string;
        owner_user_id: string;
        status: string;
        fetch_frequency: string;
        schedule_rule_json: unknown;
      }>(
        `UPDATE source_channels SET status='active', fetch_frequency='daily', schedule_rule_json=COALESCE(schedule_rule_json, '{"frequency":"daily","hour":0,"minute":0}'::jsonb), updated_at=$3
          WHERE space_id=$1 AND id=$2
          RETURNING id, space_id,
            (SELECT owner_user_id FROM source_connections WHERE id=source_channels.source_connection_id) AS owner_user_id,
            status, fetch_frequency, schedule_rule_json`,
        [spaceId, channelId, now],
      );
      const target = channel.rows[0];
      if (!target) continue;
      const channelWatermark = await latestPublicationWatermarkForItems(this.db, {
        spaceId,
        sourceItemIds: state.source_item_ids,
        sourceChannelId: channelId,
      }) ?? state.watermark.after;
      await upsertSourceChannelScanTask(this.db, {
        channel: target,
        nextRunAt: computeNextCheckAt(target.fetch_frequency, now, {
          scheduleRule: target.schedule_rule_json,
        }),
        ...(channelWatermark
          ? {
              cursor: {
                last_published_at: channelWatermark,
                overlap_hours: state.watermark.overlap_hours,
              },
              watermark: { value: channelWatermark },
            }
          : {}),
        updatedAt: now,
      });
    }
    for (const ruleId of state.source_post_processing_rule_ids ?? []) {
      await this.db.query(
        `UPDATE source_post_processing_rules SET status='active', updated_at=$3 WHERE space_id=$1 AND id=$2 AND status <> 'archived'`,
        [spaceId, ruleId, new Date().toISOString()],
      );
    }
  }

  private async waivePendingScreeningCheckpoint(
    identity: SpaceUserIdentity,
    projectId: string,
    workflowId: string,
    operationId: string,
    reason: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE project_research_checkpoints
          SET status='waived', user_decision='waived', decision_reason=$4, decided_by_user_id=$5, decided_at=$6, updated_at=$6
        WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3 AND checkpoint_type='screening_gate' AND status='pending'
          AND machine_result_json->>'operation_id'=$7`,
      [identity.spaceId, projectId, workflowId, reason, identity.userId, now, operationId],
    );
  }

  private async workflow(spaceId: string, projectId: string, workflowId: string | null, forUpdate = false, includeDraft = false): Promise<WorkflowRow | null> {
    const projection = researchWorkflowProjection();
    const result = await this.db.query<WorkflowRow>(
      `SELECT ${projection.columns} FROM ${projection.from}
        WHERE w.space_id=$1 AND w.project_id=$2
          ${workflowId ? "AND w.object_id=$3" : includeDraft ? "AND w.status IN ('active','paused','not_started')" : "AND w.status IN ('active','paused')"}
        ORDER BY workflow_object.updated_at DESC LIMIT 1${forUpdate ? " FOR UPDATE OF w" : ""}`,
      workflowId ? [spaceId, projectId, workflowId] : [spaceId, projectId],
    );
    return result.rows[0] ?? null;
  }

  private async workflowByThread(
    spaceId: string,
    projectId: string,
    threadId: string,
    forUpdate: boolean,
  ): Promise<WorkflowRow | null> {
    const projection = researchWorkflowProjection();
    const result = await this.db.query<WorkflowRow>(
      `SELECT ${projection.columns} FROM ${projection.from}
        WHERE w.space_id=$1 AND w.project_id=$2 AND w.status<>'archived'
          AND pin.primary_thread_id=$3
        ORDER BY workflow_object.updated_at DESC LIMIT 1${forUpdate ? " FOR UPDATE OF w" : ""}`,
      [spaceId, projectId, threadId],
    );
    return result.rows[0] ?? null;
  }

  private async operation(spaceId: string, operationId: string): Promise<OperationRow | null> {
    const result = await this.db.query<OperationRow>(
      `SELECT id,space_id,project_id,status,progress_json,created_at,
              current_execution_id
         FROM project_operations WHERE id=$1 AND space_id=$2`,
      [operationId, spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async operationForResearchRun(
    spaceId: string,
    runId: string,
  ): Promise<OperationRow | null> {
    const run = await this.db.query<{ contract_snapshot_json: unknown }>(
      `SELECT contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, spaceId],
    );
    const contract = objectValue(
      objectValue(run.rows[0]?.contract_snapshot_json).workflow_input_json,
    ).project_research;
    const operationId = optionalString(objectValue(contract).operation_id);
    return operationId ? this.operation(spaceId, operationId) : null;
  }

  private async activeIncremental(spaceId: string, projectId: string, workflowId: string) {
    const result = await this.db.query<OperationRow>(
      `SELECT id,space_id,project_id,status,progress_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research'
          AND status IN ('active','waiting_review')
          AND progress_json->>'run_kind'='incremental'
          AND progress_json->>'workflow_id'=$3
          AND progress_json->>'current_stage' IN ('screening','monitor_setup','backfill')
        ORDER BY updated_at DESC LIMIT 1`,
      [spaceId, projectId, workflowId],
    );
    return result.rows[0] ?? null;
  }

  private async activeHistoricalBackfill(spaceId: string, projectId: string, workflowId: string) {
    const result = await this.db.query<OperationRow>(
      `SELECT id,space_id,project_id,status,progress_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research'
          AND status IN ('active','waiting_review')
          AND progress_json->>'run_kind'='historical_backfill'
          AND progress_json->>'workflow_id'=$3
        ORDER BY updated_at DESC LIMIT 1`,
      [spaceId, projectId, workflowId],
    );
    return result.rows[0] ?? null;
  }

  private async activeResearchOperation(spaceId: string, projectId: string, workflowId: string) {
    const result = await this.db.query<OperationRow>(
      `SELECT id,space_id,project_id,status,progress_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research'
          AND status IN ('active','waiting_review')
          AND progress_json->>'workflow_id'=$3
        ORDER BY updated_at DESC LIMIT 1`,
      [spaceId, projectId, workflowId],
    );
    return result.rows[0] ?? null;
  }

  private async operationByIdempotency(spaceId: string, projectId: string, key: string): Promise<OperationRow | null> {
    const result = await this.db.query<OperationRow>(
      `SELECT id,space_id,project_id,status,progress_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research'
          AND progress_json->'idempotency'->>'key'=$3
        ORDER BY created_at LIMIT 1`,
      [spaceId, projectId, key],
    );
    return result.rows[0] ?? null;
  }

  private async appendWorkflowCoverage(
    spaceId: string,
    projectId: string,
    workflowId: string,
    range: { from: string; to: string; operation_id: string; status: "pending" | "completed" | "partial" },
  ): Promise<void> {
    const workflow = await this.workflow(spaceId, projectId, workflowId);
    if (!workflow) throw new HttpError(404, "Research workflow not found");
    const state = objectValue(workflow.state_json);
    const ranges = historyCoverage(state).filter((item) => item.operation_id !== range.operation_id);
    ranges.push(range);
    const now = new Date().toISOString();
    await this.db.query(
      `WITH changed AS (UPDATE project_research_workflows
        SET state_json=jsonb_set(COALESCE(state_json,'{}'::jsonb),'{coverage_ranges}',$4::jsonb,true)
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
       UPDATE space_objects object SET updated_at=$5 FROM changed
        WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
      [spaceId, projectId, workflowId, JSON.stringify(ranges), now],
    );
  }

  private async completeWorkflowCoverage(
    spaceId: string,
    projectId: string,
    workflowId: string,
    operationId: string,
    status: "completed" | "partial",
  ): Promise<void> {
    const workflow = await this.workflow(spaceId, projectId, workflowId);
    if (!workflow) return;
    const ranges = historyCoverage(workflow.state_json).map((range) =>
      range.operation_id === operationId ? { ...range, status } : range,
    );
    const now = new Date().toISOString();
    await this.db.query(
      `WITH changed AS (UPDATE project_research_workflows
        SET state_json=jsonb_set(COALESCE(state_json,'{}'::jsonb),'{coverage_ranges}',$4::jsonb,true)
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
       UPDATE space_objects object SET updated_at=$5 FROM changed
        WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
      [spaceId, projectId, workflowId, JSON.stringify(ranges), now],
    );
  }

  private async sourceItemsForBackfillPlans(spaceId: string, planIds: string[]): Promise<string[]> {
    if (planIds.length === 0) return [];
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM source_items
        WHERE space_id=$1 AND deleted_at IS NULL
          AND (
            metadata_json->>'source_backfill_plan_id'=ANY($2::text[])
            OR metadata_json->>'source_backfill_created_plan_id'=ANY($2::text[])
          )`,
      [spaceId, planIds],
    );
    return result.rows.map((row) => row.id);
  }

  private async backfillPlanForItems(spaceId: string, itemIds: string[]): Promise<Map<string, { last_plan_id: string | null; created_plan_id: string | null }>> {
    if (itemIds.length === 0) return new Map();
    const result = await this.db.query<{ id: string; last_plan_id: string | null; created_plan_id: string | null }>(
      `SELECT id,
              metadata_json->>'source_backfill_plan_id' AS last_plan_id,
              metadata_json->>'source_backfill_created_plan_id' AS created_plan_id
         FROM source_items
        WHERE space_id=$1 AND id=ANY($2::text[])`,
      [spaceId, itemIds],
    );
    return new Map(result.rows.map((row) => [row.id, { last_plan_id: row.last_plan_id, created_plan_id: row.created_plan_id }]));
  }

  private async appendPendingIncrementalItems(spaceId: string, projectId: string, workflowId: string, itemIds: string[]): Promise<void> {
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, spaceId, projectId);
      await new ProjectResearchOrchestrator(db, this.config).appendPendingIncrementalItemsLocked(
        spaceId, projectId, workflowId, itemIds,
      );
    });
  }

  private async appendPendingIncrementalItemsLocked(spaceId: string, projectId: string, workflowId: string, itemIds: string[]): Promise<void> {
    const workflow = await this.workflow(spaceId, projectId, workflowId, true);
    if (!workflow) return;
    const state = objectValue(workflow.state_json);
    const pending = unique([...stringArray(state.pending_incremental_source_item_ids), ...itemIds]);
    const now = new Date().toISOString();
    await this.db.query(
      `WITH changed AS (UPDATE project_research_workflows
        SET state_json=jsonb_set(COALESCE(state_json,'{}'::jsonb),'{pending_incremental_source_item_ids}',$4::jsonb,true)
        WHERE space_id=$1 AND project_id=$2 AND object_id=$3 RETURNING object_id,space_id)
       UPDATE space_objects object SET updated_at=$5 FROM changed
        WHERE object.id=changed.object_id AND object.space_id=changed.space_id`,
      [spaceId, projectId, workflowId, JSON.stringify(pending), now],
    );
  }

  private async flushPendingIncremental(spaceId: string, projectId: string, workflowId: string): Promise<void> {
    const workflow = await this.workflow(spaceId, projectId, workflowId);
    if (!workflow) return;
    if (await this.hasResearchQuestionDrift(spaceId, projectId, workflow.state_json)) return;
    const state = objectValue(workflow.state_json);
    const pending = unique(stringArray(state.pending_incremental_source_item_ids));
    if (pending.length === 0) return;
    const actorUserId = await this.projectWriterActor(spaceId, projectId);
    if (!actorUserId) return;
    await this.triggerIncremental(
      { spaceId, userId: actorUserId },
      projectId,
      workflowId,
      { source_item_ids: pending, idempotency_key: `deferred-source-flush:${workflowId}:${pending.join(",")}` },
    );
  }

  private async hasResearchQuestionDrift(spaceId: string, projectId: string, workflowValue: unknown): Promise<boolean> {
    const workflow = objectValue(workflowValue);
    const scope = normalizeThreadScope(workflow.thread_scope);
    const pinned = scope[0];
    if (!pinned) return true;
    // The pinned Inquiry Thread is the sole Question authority for this
    // Workflow. Project.current_focus and the legacy research profile are
    // presentation/setup state; comparing either here would let selecting a
    // different Workflow incorrectly stall this one.
    return (await checkPinnedThreadDrift(this.db, spaceId, projectId, pinned)).drifted;
  }

  private async assertResearchQuestionAligned(spaceId: string, projectId: string, workflowValue: unknown): Promise<void> {
    if (await this.hasResearchQuestionDrift(spaceId, projectId, workflowValue)) {
      throw new HttpError(409, "The scoped Inquiry Thread changed. Apply its current revision before continuing research.");
    }
  }

  private async operationForCheckpoint(spaceId: string, projectId: string, checkpointId: string) {
    const result = await this.db.query<OperationRow>(
      `SELECT po.id,po.space_id,po.project_id,po.status,po.progress_json FROM project_operations po JOIN project_research_checkpoints c ON c.machine_result_json->>'operation_id'=po.id WHERE po.space_id=$1 AND po.project_id=$2 AND c.id=$3 LIMIT 1`,
      [spaceId, projectId, checkpointId],
    );
    return result.rows[0] ?? null;
  }

  private async setState(
    operation: Pick<OperationRow, "id" | "space_id" | "project_id" | "progress_json">,
    state: ResearchOperationState,
    steps: ResearchStepOverride[],
  ) {
    await setResearchOperationState(this.db, operation, state, steps);
  }

  private async failOperation(
    operation: OperationRow,
    message: string,
    details: {
      code?: string;
      diagnostics?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    if (["completed", "failed", "cancelled"].includes(operation.status)) return;
    const state = researchState(operation.progress_json);
    const failedStage = state.current_stage;
    state.stage_state = "failed";
    state.current_stage = "failed";
    if (failedStage === "screening") {
      const progress = await this.screeningProgressFor(
        operation.space_id,
        operation.project_id,
        operation.id,
        state,
        operation.created_at,
      );
      state.screening_progress = {
        ...progress,
        phase: "failed",
        message: "Screening failed. Review the operation error and retry the screening stage.",
      };
    }
    const error: ResearchOperationError = {
      code: details.code ?? "research_operation_failed",
      message,
      at: new Date().toISOString(),
      ...(details.diagnostics ? { diagnostics: details.diagnostics } : {}),
    };
    const failedSteps = deriveStepStates({ ...state, current_stage: failedStage })
      .map((step) => step.seq === researchStageIndex(failedStage)
        ? {
            ...step,
            detail: {
              error: message,
              error_code: error.code,
              ...(details.diagnostics ? { diagnostics: details.diagnostics } : {}),
            },
          }
        : step);
    await this.setState(operation, { ...state, failed_stage: failedStage, error }, failedSteps);
    await this.notifyRoomOfOperationStatus(operation, "failed", message);
  }

  /** Reports one `research_workflow_terminal` variant to the Operation's
   * originating Room. Inert for every operation without a Room origin — i.e.
   * every operation not started via `research.start_acquisition`.
   *
   * All three variants (`failed`, `completed`, `waiting_review`) go through
   * here. The last two became reachable with the checkpoint reform: before
   * it, a Room-started acquisition that finished or paused told
   * the Room nothing, and the user had to discover it from the web UI's
   * Operation surface — which is precisely the interruption the reform set out
   * to remove, so removing the gates without wiring these would have made the
   * Room *less* informative, not more.
   *
   * Enqueues a job via `this.db` rather than posting the Room message
   * directly. `failOperation` is called from action-node handlers that
   * `WorkflowExecutionService.runActionNode` wraps in a `SAVEPOINT` — on
   * rethrow (which every `failOperation` call site does) that savepoint is
   * rolled back, discarding this method's own `setState` "failed" write made
   * moments earlier via the same client. A Room message posted through an
   * independent connection would not be rolled back with it: the user would
   * be told the operation failed while the database still shows it as not
   * failed, and the event-key dedupe (`findRoomEventContinuation`) would then
   * permanently swallow the real notification once the failure is genuinely
   * recorded on a later attempt. Enqueuing through `this.db` instead ties the
   * notification's fate to the same commit/rollback boundary as the state
   * write it reports on — both persist together, or neither does. */
  /** Once-per-episode is each *call site's* responsibility, not this method's:
   * `failed` fires once per pass (`failOperation` early-returns on a terminal
   * row), `completed` paths are reached once, and the `waiting_review` pause
   * notifies only on the transition edge (`createGate` checks the prior
   * `stage_state`). An earlier version deduped here against any previously
   * enqueued `(operation, status)` job, which was permanent — a retried
   * operation's second failure, or a second distinct pause, was silently
   * dropped forever. The `episode` (the operation's pass generation, for
   * `failed`) flows into the Room event key so a genuinely new episode of the
   * same status is a new Room event rather than a Room-side dedupe casualty. */
  private async notifyRoomOfOperationStatus(
    operation: Pick<OperationRow, "id" | "space_id" | "project_id" | "progress_json">,
    status: "failed" | "completed" | "waiting_review",
    message: string,
  ): Promise<void> {
    const origin = objectValue(operation.progress_json);
    const roomId = optionalString(origin.origin_room_id);
    const sessionId = optionalString(origin.origin_session_id);
    if (!roomId || !sessionId) return;
    const identity = await this.projectWriterActor(operation.space_id, operation.project_id);
    if (!identity) return;
    let episode: number | null = null;
    if (status === "failed") {
      const row = await this.db.query<{ generation: number }>(
        `SELECT generation FROM project_operations WHERE id=$1 AND space_id=$2`,
        [operation.id, operation.space_id],
      );
      episode = row.rows[0]?.generation ?? null;
    }
    await new PgJobQueueRepository(this.db).enqueue({
      job_type: RESEARCH_OPERATION_FAILURE_NOTIFY_JOB,
      space_id: operation.space_id,
      user_id: identity,
      payload: {
        operation_id: operation.id,
        room_id: roomId,
        session_id: sessionId,
        status,
        ...(episode === null ? {} : { episode }),
        reason: message,
      },
    });
  }

  private async readOperation(identity: SpaceUserIdentity, projectId: string, operationId: string): Promise<OperationRead> {
    return await new ProjectOperationService(this.db).get(identity, projectId, operationId) as unknown as OperationRead;
  }

  private async startResponse(identity: SpaceUserIdentity, projectId: string, operationId: string) {
    const operation = await this.readOperation(identity, projectId, operationId);
    const state = researchState(operation.progress_json);
    const workflow = await this.workflow(identity.spaceId, projectId, state.workflow_id);
    const channelRows = state.channel_ids?.length
      ? await new SourceChannelService(this.db, this.config!).listForSpaceByIds(identity, state.channel_ids)
      : [];
    const bindingIds = state.project_source_binding_ids?.length
      ? state.project_source_binding_ids
      : state.project_source_binding_id ? [state.project_source_binding_id] : [];
    const bindingRows = bindingIds.length
      ? (await this.db.query(
        `SELECT * FROM project_source_bindings WHERE id=ANY($1::text[]) AND space_id=$2 ORDER BY created_at ASC`,
        [bindingIds, identity.spaceId],
      )).rows
      : [];
    return {
      workflow,
      operation,
      source_channel: channelRows[0] ?? null,
      source_channels: channelRows,
      source_binding: bindingRows[0] ?? null,
      source_bindings: bindingRows,
      status: operation.status === "completed" ? "succeeded" : operation.status,
    };
  }

  private async enqueueReconcile(
    spaceId: string,
    userId: string | null,
    operationId: string | null,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await new PgJobQueueRepository(this.db).enqueue({
      job_type: "project_research_execution_nudge",
      space_id: spaceId,
      user_id: userId,
      payload: {
        ...(operationId ? { operation_id: operationId } : {}),
        ...extra,
        reason,
      },
    });
  }

  private async enqueueIntegrityMonitor(
    spaceId: string,
    userId: string | null,
    projectId: string,
    workflowId: string,
    reason: string,
  ): Promise<void> {
    const active = await this.db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE space_id=$1 AND job_type='project_research_integrity_monitor'
        AND payload_json->>'project_id'=$2 AND status IN ('pending','claimed','running') LIMIT 1`,
      [spaceId, projectId],
    );
    if (active.rows[0]) return;
    await new PgJobQueueRepository(this.db).enqueue({
      job_type: "project_research_integrity_monitor",
      space_id: spaceId,
      user_id: userId,
      payload: { project_id: projectId, workflow_id: workflowId, reason },
    });
  }

}

export function registerProjectResearchHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  registry.register("project_research_execution_nudge", async (job): Promise<JobHandlerResult> => {
    const db = getDbPool(config.databaseUrl!);
    const orchestrator = new ProjectResearchOrchestrator(db, config);
    const operationId = optionalString(job.payload.operation_id);
    const runId = optionalString(job.payload.run_id);
    const sourcePostProcessingRunId = optionalString(job.payload.source_post_processing_run_id);
    if (runId) await orchestrator.reconcileRun(job.space_id, runId);
    if (sourcePostProcessingRunId) await orchestrator.reconcilePostProcessingRun(job.space_id, sourcePostProcessingRunId);
    if (operationId) await orchestrator.reconcileOperation(job.space_id, operationId);
    return { operation_id: operationId, run_id: runId, source_post_processing_run_id: sourcePostProcessingRunId, status: "reconciled" };
  });
  registry.register("project_research_integrity_monitor", async (job): Promise<JobHandlerResult> => {
    const projectId = optionalString(job.payload.project_id);
    const workflowId = optionalString(job.payload.workflow_id);
    if (!projectId || !workflowId) throw new Error("project_research_integrity_monitor requires project_id and workflow_id");
    return new ProjectResearchIntegrityMonitorService(getDbPool(config.databaseUrl!)).check({
      spaceId: job.space_id,
      projectId,
      workflowId,
      userId: job.user_id,
    });
  });
  registry.register(STANDING_COMPARISON_JOB_TYPE, async (job): Promise<JobHandlerResult> => {
    const batchId = optionalString(job.payload.batch_id);
    if (!batchId) throw new Error(`${STANDING_COMPARISON_JOB_TYPE} requires batch_id`);
    return new ProjectResearchStandingComparisonService(getDbPool(config.databaseUrl!), config)
      .dispatchBatch(job.space_id, batchId);
  });
  registry.register(STANDING_COMPARISON_RECONCILE_JOB_TYPE, async (job): Promise<JobHandlerResult> => {
    const runId = optionalString(job.payload.run_id);
    if (!runId) throw new Error(`${STANDING_COMPARISON_RECONCILE_JOB_TYPE} requires run_id`);
    return new ProjectResearchStandingComparisonService(getDbPool(config.databaseUrl!), config)
      .reconcileRun(job.space_id, runId);
  });
}

function normalizeInitialIntakeInput(body: Record<string, unknown>, profileQuestion: string | null): ResearchInput {
  rejectLegacyResearchRuntimeFields(body);
  const queryStrategyId = optionalString(body.query_strategy_id);
  if (!queryStrategyId) throw new HttpError(422, "query_strategy_id is required");
  // The materialized project-owned strategy replaces this placeholder before
  // any operation or workflow state is written.
  const researchQuestion = optionalString(body.research_question) ?? profileQuestion ?? "materialized research query";
  const sourceChannelIds: string[] = [];
  const historyMode = optionalString(body.history_mode) ?? "bounded_range";
  if (historyMode !== "bounded_range" && historyMode !== "all_available") {
    throw new HttpError(422, "history_mode must be bounded_range or all_available");
  }
  const requestedFrom = optionalString(body.from);
  const requestedTo = optionalString(body.to);
  let from: string;
  let to: string;
  if (historyMode === "all_available") {
    if (requestedFrom || requestedTo) throw new HttpError(422, "from and to must be omitted for all_available history");
    from = ARXIV_HISTORY_FLOOR;
    to = new Date().toISOString();
  } else {
    if (!requestedFrom || !requestedTo) throw new HttpError(422, "from and to are required for bounded_range initial material intake");
    if (Number.isNaN(Date.parse(requestedFrom)) || Number.isNaN(Date.parse(requestedTo)) || Date.parse(requestedFrom) >= Date.parse(requestedTo)) throw new HttpError(422, "from must be earlier than to");
    from = new Date(requestedFrom).toISOString();
    to = new Date(requestedTo).toISOString();
  }
  const maxItems = body.max_items === undefined ? MAX_ITEMS_DEFAULT : Number(body.max_items);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS_DEFAULT) throw new HttpError(422, `max_items must be an integer between 1 and ${MAX_ITEMS_DEFAULT}`);
  const monitoringField = optionalString(body.monitoring_field) ?? "submittedDate";
  if (!MONITORING_FIELDS.has(monitoringField)) throw new HttpError(422, "monitoring_field must be submittedDate or lastUpdatedDate");
  const schedule = optionalString(body.schedule) ?? "daily";
  if (schedule !== "daily") throw new HttpError(422, "v1 supports a daily monitoring schedule");
  const executionBody = objectValue(body.execution);
  const reportDepth = normalizeReportDepth(body.report_depth);
  const questionRefineSkipped = normalizeQuestionRefineSkipped(body.question_refine_skipped);
  // Refinement is a hard gate for starting (revised D5): a failing question
  // may still be saved as a draft, but it cannot spend the intake budget.
  if (questionRefineSkipped) {
    throw new HttpError(422, "The research question has not passed refinement; adopt a suggested question or reassess with your answers before starting");
  }
  const researchScope = researchScopeFromRefinement(body.question_refinement);
  const execution: ResearchExecutionSelection = {
    modelProviderId: optionalString(executionBody.model_provider_id),
    modelName: optionalString(executionBody.model_name),
  };
  const idempotencyKey = optionalString(body.idempotency_key) ?? fingerprintOf({ queryStrategyId, historyMode, from: historyMode === "bounded_range" ? from : null, to: historyMode === "bounded_range" ? to : null, maxItems, monitoringField, schedule, execution });
  return {
    workflowId: optionalString(body.workflow_id),
    researchQuestion,
    requestedThreadId: optionalString(body.thread_id),
    threadScope: [],
    sourceChannelIds,
    historyMode: historyMode as HistoryMode,
    from,
    to,
    maxItems,
    monitoringField: monitoringField as ResearchInput["monitoringField"],
    schedule: "daily",
    agentId: "",
    runtimeProfileId: "",
    execution,
    idempotencyKey,
    reportDepth,
    questionRefineSkipped,
    queryStrategyId,
    researchScope,
  };
}

function normalizeInitialIntakeDraft(body: Record<string, unknown>, profileQuestion: string | null): InitialIntakeDraft {
  rejectLegacyResearchRuntimeFields(body);
  const researchQuestion = optionalString(body.research_question) ?? profileQuestion;
  if (!researchQuestion) throw new HttpError(422, "research_question is required");
  // A draft may be saved before any monitor exists (question refinement is
  // step one); only starting the intake requires monitors.
  const sourceChannelIds = normalizeSourceChannelIds(body.source_channel_ids);
  const historyMode = optionalString(body.history_mode) ?? "bounded_range";
  if (historyMode !== "bounded_range" && historyMode !== "all_available") {
    throw new HttpError(422, "history_mode must be bounded_range or all_available");
  }
  const from = historyMode === "all_available" ? null : optionalDraftDate(body.from);
  const to = historyMode === "all_available" ? null : optionalDraftDate(body.to);
  if (from && to && Date.parse(from) >= Date.parse(to)) throw new HttpError(422, "from must be earlier than to");
  const maxItems = body.max_items === undefined || body.max_items === "" ? MAX_ITEMS_DEFAULT : Number(body.max_items);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS_DEFAULT) {
    throw new HttpError(422, `max_items must be an integer between 1 and ${MAX_ITEMS_DEFAULT}`);
  }
  const monitoringField = optionalString(body.monitoring_field) ?? "submittedDate";
  if (!MONITORING_FIELDS.has(monitoringField)) throw new HttpError(422, "monitoring_field must be submittedDate or lastUpdatedDate");
  const schedule = optionalString(body.schedule) ?? "daily";
  if (schedule !== "daily") throw new HttpError(422, "v1 supports a daily monitoring schedule");
  const executionBody = objectValue(body.execution);
  const reportDepth = normalizeReportDepth(body.report_depth);
  const questionRefineSkipped = normalizeQuestionRefineSkipped(body.question_refine_skipped);
  const researchContextVersionId = optionalString(body.research_context_version_id);
  const queryStrategyId = optionalString(body.query_strategy_id);
  const questionRefinement = normalizeQuestionRefinementDraft(body.question_refinement);
  return {
    researchQuestion,
    requestedThreadId: optionalString(body.thread_id),
    researchContextVersionId,
    sourceChannelIds,
    historyMode: historyMode as HistoryMode,
    from,
    to,
    maxItems,
    monitoringField: monitoringField as InitialIntakeDraft["monitoringField"],
    schedule: "daily",
    execution: {
      modelProviderId: optionalString(executionBody.model_provider_id),
      modelName: optionalString(executionBody.model_name),
    },
    reportDepth,
    questionRefineSkipped,
    queryStrategyId,
    questionRefinement,
  };
}

function normalizeQuestionRefinementDraft(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(422, "question_refinement must be an object");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(record).length > 20_000) throw new HttpError(422, "question_refinement is too large to persist");
  return record;
}

function normalizeSourceChannelIds(value: unknown): string[] {
  return unique(Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim())
    : []);
}

function normalizeReportDepth(value: unknown): ResearchReportDepth {
  const depth = optionalString(value);
  if (!depth) throw new HttpError(422, "report_depth is required");
  if (depth !== "quick" && depth !== "full") throw new HttpError(422, "report_depth must be quick or full");
  return depth;
}

function normalizeQuestionRefineSkipped(value: unknown): boolean {
  if (typeof value !== "boolean") throw new HttpError(422, "question_refine_skipped is required");
  return value;
}

function optionalDraftDate(value: unknown): string | null {
  const raw = optionalString(value);
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? raw : new Date(raw).toISOString();
}

function initialIntakeDraftState(draft: InitialIntakeDraft, savedAt: string): Record<string, unknown> {
  return {
    schema_version: "project_research_initial_intake.v1",
    research_question: draft.researchQuestion,
    thread_id: draft.requestedThreadId,
    research_question_version: 1,
    research_context_version_id: draft.researchContextVersionId,
    source_channel_ids: draft.sourceChannelIds,
    initial_intake: {
      history_mode: draft.historyMode,
      from: draft.from,
      to: draft.to,
      max_items: draft.maxItems,
      monitoring_field: draft.monitoringField,
      schedule: draft.schedule,
      report_depth: draft.reportDepth,
    },
    execution: {
      model_provider_id: draft.execution.modelProviderId ?? null,
      model_name: draft.execution.modelName ?? null,
    },
    question_refine_skipped: draft.questionRefineSkipped,
    query_strategy_id: draft.queryStrategyId,
    question_refinement: draft.questionRefinement,
    research_scope: researchScopeFromRefinement(draft.questionRefinement),
    draft: { status: "saved", saved_at: savedAt },
  };
}

function workflowOutput(row: WorkflowRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    current_stage: row.current_stage ?? null,
    status: row.status,
    state_json: objectValue(row.state_json),
    primary_thread_id: row.primary_thread_id ?? null,
    started_by_user_id: row.started_by_user_id ?? null,
    started_run_id: row.started_run_id ?? null,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function initialIntakeFingerprint(input: ResearchInput): string {
  return fingerprintOf({
    researchQuestion: input.researchQuestion,
    threadScope: input.threadScope,
    sourceChannelIds: input.sourceChannelIds,
    historyMode: input.historyMode,
    from: input.historyMode === "bounded_range" ? input.from : null,
    to: input.historyMode === "bounded_range" ? input.to : null,
    maxItems: input.maxItems,
    monitoringField: input.monitoringField,
    schedule: input.schedule,
    execution: input.execution,
    reportDepth: input.reportDepth,
    questionRefineSkipped: input.questionRefineSkipped,
    queryStrategyId: input.queryStrategyId,
    researchScope: input.researchScope,
  });
}

function questionVersion(value: unknown): number {
  const version = objectValue(value).research_question_version;
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : 1;
}

function initialState(input: ResearchInput, workflowId: string, fingerprint: string): ResearchOperationState {
  return {
    schema_version: "project_research_operation.v1", run_kind: "baseline", workflow_id: workflowId, query_strategy_id: input.queryStrategyId, research_question: input.researchQuestion, research_question_version: 1, thread_scope: input.threadScope, research_scope: input.researchScope, report_depth: input.reportDepth, question_refine_skipped: input.questionRefineSkipped, channel_ids: input.sourceChannelIds, project_source_binding_ids: [], source_post_processing_rule_ids: [], project_source_binding_id: null, source_post_processing_rule_id: null, source_backfill_plan_id: null,
    query: { source_channel_ids: input.sourceChannelIds, fingerprint: fingerprintOf({ source_channel_ids: input.sourceChannelIds, history_mode: input.historyMode, from: input.from, to: input.to, sort_by: input.monitoringField }), sort_by: input.monitoringField, history_mode: input.historyMode, from: input.from, to: input.to },
    history: { mode: input.historyMode, from: input.from, to: input.to, max_items: input.maxItems }, watermark: { before: null, after: null, overlap_hours: OVERLAP_HOURS }, source_item_ids: [], current_stage: "monitor_setup", stage_state: "running", agent_id: input.agentId, runtime_profile_id: input.runtimeProfileId,
    source_backfill_plan_ids: [], checkpoint_ids: [], synthesis_run_id: null, artifact_ids: [], partial: false, monitoring_active: false, idempotency: { key: input.idempotencyKey, fingerprint },
  };
}

export function incrementalStateFromWorkflow(
  workflowValue: unknown,
  workflowId: string,
  sourceItemIds: string[],
  idempotencyKey: string,
  watermark: ResearchOperationState["watermark"] | null,
): ResearchOperationState {
  const workflow = objectValue(workflowValue);
  const monitoring = objectValue(workflow.monitoring);
  const monitoringField = optionalString(monitoring.field) === "lastUpdatedDate" ? "lastUpdatedDate" : "submittedDate";
  const resolvedWatermark = watermark ?? {
    before: optionalString(monitoring.watermark_after),
    after: null,
    overlap_hours: OVERLAP_HOURS,
  };
  return {
    schema_version: "project_research_operation.v1",
    run_kind: "incremental",
    workflow_id: workflowId,
    research_question: optionalString(workflow.research_question) ?? "Project research",
    research_question_version: questionVersion(workflow),
    thread_scope: normalizeThreadScope(workflow.thread_scope),
    research_scope: normalizeResearchScope(workflow.research_scope),
    report_depth: normalizeReportDepth(workflow.report_depth),
    question_refine_skipped: workflow.question_refine_skipped === true,
    channel_ids: stringArray(workflow.channel_ids),
    project_source_binding_ids: stringArray(workflow.project_source_binding_ids),
    source_post_processing_rule_ids: stringArray(workflow.source_post_processing_rule_ids),
    project_source_binding_id: optionalString(workflow.project_source_binding_id),
    source_post_processing_rule_id: optionalString(workflow.source_post_processing_rule_id),
    source_backfill_plan_id: null,
    source_backfill_plan_ids: [],
    query: {
      source_channel_ids: stringArray(workflow.source_channel_ids ?? workflow.channel_ids),
      fingerprint: fingerprintOf({ source_channel_ids: stringArray(workflow.source_channel_ids ?? workflow.channel_ids), monitoring_field: monitoringField }),
      sort_by: monitoringField,
      history_mode: null,
      from: null,
      to: null,
    },
    history: { mode: null, from: null, to: null, max_items: null },
    watermark: resolvedWatermark,
    source_item_ids: unique(sourceItemIds),
    current_stage: "screening",
    stage_state: "running",
    agent_id: optionalString(workflow.agent_id) ?? "",
    runtime_profile_id: optionalString(workflow.runtime_profile_id) ?? "",
    checkpoint_ids: [],
    synthesis_run_id: null,
    artifact_ids: [],
    partial: false,
    monitoring_active: true,
    idempotency: { key: idempotencyKey, fingerprint: fingerprintOf({ workflowId, sourceItemIds, idempotencyKey }) },
  };
}

function historicalBackfillStateFromWorkflow(
  workflowValue: unknown,
  workflowId: string,
  from: string,
  to: string,
  maxItems: number,
  idempotencyKey: string,
  fingerprint: string,
): ResearchOperationState {
  const workflow = objectValue(workflowValue);
  const monitoring = objectValue(workflow.monitoring);
  const monitoringField = optionalString(monitoring.field) === "lastUpdatedDate" ? "lastUpdatedDate" : "submittedDate";
  return {
    schema_version: "project_research_operation.v1",
    run_kind: "historical_backfill",
    workflow_id: workflowId,
    research_question: optionalString(workflow.research_question) ?? "Project research",
    research_question_version: questionVersion(workflow),
    thread_scope: normalizeThreadScope(workflow.thread_scope),
    research_scope: normalizeResearchScope(workflow.research_scope),
    report_depth: normalizeReportDepth(workflow.report_depth),
    question_refine_skipped: workflow.question_refine_skipped === true,
    channel_ids: stringArray(workflow.channel_ids),
    project_source_binding_ids: stringArray(workflow.project_source_binding_ids),
    source_post_processing_rule_ids: stringArray(workflow.source_post_processing_rule_ids),
    project_source_binding_id: optionalString(workflow.project_source_binding_id),
    source_post_processing_rule_id: optionalString(workflow.source_post_processing_rule_id),
    source_backfill_plan_id: null,
    source_backfill_plan_ids: [],
    query: {
      source_channel_ids: stringArray(workflow.source_channel_ids ?? workflow.channel_ids),
      fingerprint: fingerprintOf({ source_channel_ids: stringArray(workflow.source_channel_ids ?? workflow.channel_ids), monitoring_field: monitoringField, from, to }),
      sort_by: monitoringField,
      history_mode: "bounded_range",
      from,
      to,
    },
    history: { mode: "bounded_range", from, to, max_items: maxItems },
    watermark: { before: optionalString(monitoring.watermark_after), after: null, overlap_hours: OVERLAP_HOURS },
    source_item_ids: [],
    current_stage: "monitor_setup",
    stage_state: "running",
    agent_id: optionalString(workflow.agent_id) ?? "",
    runtime_profile_id: optionalString(workflow.runtime_profile_id) ?? "",
    checkpoint_ids: [],
    synthesis_run_id: null,
    artifact_ids: [],
    partial: false,
    monitoring_active: monitoring.active === true,
    idempotency: { key: idempotencyKey, fingerprint },
  };
}

function historyCoverage(value: unknown): Array<{ from: string; to: string; operation_id: string; status: "pending" | "completed" | "partial" }> {
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

function withOperationCoverageStatus(
  state: ResearchOperationState,
  operationId: string,
  status: "completed" | "partial",
): ResearchOperationState {
  const ranges = state.coverage_ranges ?? [];
  const matching = ranges.some((range) => range.operation_id === operationId);
  return {
    ...state,
    coverage_ranges: matching
      ? ranges.map((range) => range.operation_id === operationId ? { ...range, status } : range)
      : state.history.from && state.history.to
        ? [...ranges, { from: state.history.from, to: state.history.to, operation_id: operationId, status }]
        : ranges,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
