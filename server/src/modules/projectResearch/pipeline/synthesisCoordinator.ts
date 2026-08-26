import { randomUUID } from "node:crypto";
import type { Queryable } from "../../routeUtils/common.js";
import { dateIso, HttpError, objectValue, optionalString, withQueryableTransaction } from "../../routeUtils/common.js";
import { lockActiveProjectForMutation } from "../../projects/access.js";
import { PgJobQueueRepository } from "../../jobs/repository.js";
import { PgRunRepository } from "../../runs/repository.js";
import { runOutputResult } from "../../runs/orchestrationResults.js";
import { createManagedExecutionPolicy } from "../../policy/managedExecutionPolicy.js";
import { ProjectResearchArtifactService } from "../artifactService.js";
import { ProjectResearchReportMaterializer } from "../reportMaterializer.js";
import { assignReportReferenceIds } from "../reportReferenceNumbering.js";
import {
  validateResearchArtifacts,
  type ResearchArtifactRecord,
  type ResearchArtifactValidationFailure,
} from "../artifactValidation.js";
import { RESEARCH_SYNTHESIS_CRITIQUE_OUTPUT_CONTRACT, RESEARCH_SYNTHESIS_OUTPUT_CONTRACT } from "../outputSchemas.js";
import { checkpointBlocks, recordInformationalIdeaReview } from "../researchCheckpointPolicy.js";
import {
  PROJECT_RESEARCH_SYNTHESIS_CRITIQUE_PROMPT_KEY,
  PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY,
  resolveProjectResearchCritiquePrompt,
  resolveProjectResearchSynthesisPrompt,
} from "../promptRegistry.js";
import type { ResearchOperationState, ResearchStage, ResearchMutationResult } from "../operationProjection.js";
import { researchStage, researchState, advanceOperation as advanceResearchOperation } from "../operationProjection.js";
import { deriveStepStates } from "../operationProjection.js";
import { setResearchOperationState } from "./operationProjectionWriter.js";

export const RESEARCH_SYNTHESIS_CAPABILITIES = [
  "research.source_collect",
  "research.source_summarize",
  "research.evidence_extract",
  "research.brief_synthesize",
  "research.idea_generate",
];

export interface SynthesisOperationRow {
  id: string;
  space_id: string;
  project_id: string;
  status: string;
  progress_json: unknown;
}

export interface QueueSynthesisInput {
  spaceId: string;
  userId: string;
  projectId: string;
  operationId: string;
  workflowId: string;
  from: readonly ResearchStage[];
  reuseExistingRun: boolean;
  stageKey?: "synthesis" | "synthesis_revision";
  critiqueContext?: string;
}

export interface QueueSynthesisStageInput {
  spaceId: string;
  userId: string;
  projectId: string;
  operationId: string;
  workflowId: string;
}

export interface ProjectResearchSynthesisPorts {
  operation(spaceId: string, operationId: string): Promise<SynthesisOperationRow | null>;
  setWorkflowMonitoring(
    spaceId: string,
    projectId: string,
    workflowId: string,
    state: ResearchOperationState,
  ): Promise<void>;
  failOperation(
    operation: SynthesisOperationRow,
    message: string,
    details?: { code?: string; diagnostics?: Record<string, unknown> },
  ): Promise<void>;
  projectWriterActor(spaceId: string, projectId: string): Promise<string | null>;
  reconcileCompletedRun(spaceId: string, runId: string): Promise<void>;
  createCheckpoint(
    db: Queryable,
    spaceId: string,
    projectId: string,
    workflowId: string,
    operationId: string,
    type: string,
    result: Record<string, unknown>,
  ): Promise<string>;
}

/** Owns the atomic approved-corpus -> synthesis-run/empty-result transition. */
export class ProjectResearchSynthesisCoordinator {
  constructor(
    private readonly db: Queryable,
    private readonly ports: ProjectResearchSynthesisPorts,
  ) {}

  async queue(input: QueueSynthesisInput): Promise<ResearchMutationResult> {
    const { spaceId, userId, projectId, operationId, workflowId } = input;
    let emptyMatrix = false;
    const result = await advanceResearchOperation(this.db, spaceId, operationId, {
      from: input.from,
      to: "synthesis",
      mutate: async ({ db, state: current }) => {
        current.stage_state = "running";
        delete current.failed_stage;
        if (input.reuseExistingRun && current.synthesis_run_id) return;
        const resolvedPrompt = await resolveProjectResearchSynthesisPrompt(db, {
          spaceId,
          userId,
          projectId,
          agentId: current.agent_id,
          researchQuestion: researchQueryText(current),
          researchScope: current.research_scope,
          reportDepth: current.report_depth,
          critiqueContext: input.critiqueContext,
        });
        if (!resolvedPrompt) throw new HttpError(500, "Project Research synthesis prompt is not resolvable");
        const matrixArtifactId = await new ProjectResearchArtifactService(db).ensureEvidenceMatrix({
          spaceId,
          projectId,
          workflowId,
          operationId,
          ownerUserId: userId,
        });
        current.matrix_artifact_id = matrixArtifactId;
        current.artifact_ids = unique([...current.artifact_ids, matrixArtifactId]);
        if (await evidenceMatrixRowCount(db, spaceId, projectId, matrixArtifactId) === 0) {
          emptyMatrix = true;
          return false;
        }
        const run = await new PgRunRepository(db).createQueuedRunWithBudgetAdmission({
          agent_id: current.agent_id,
          space_id: spaceId,
          user_id: userId,
          mode: "live",
          run_type: "agent",
          trigger_origin: "system",
          project_id: projectId,
          runtime_profile_id: current.runtime_profile_id || null,
          prompt: `${input.stageKey === "synthesis_revision" ? "Revise" : "Synthesize"} the approved project research corpus for: ${researchQueryText(current)}`,
          instruction: resolvedPrompt.instruction,
          capability_id: "research.brief_synthesize",
          capabilities_json: RESEARCH_SYNTHESIS_CAPABILITIES,
          contract_snapshot: {
            source: { kind: "workflow", id: workflowId },
            project_id: projectId,
            required_outputs_json: { artifact_types: ["research_report.archive.v1"] },
            structured_output_json: RESEARCH_SYNTHESIS_OUTPUT_CONTRACT,
            workflow_input_json: {
              project_research: {
                workflow_id: workflowId,
                operation_id: operationId,
                evidence_matrix_artifact_id: matrixArtifactId,
                run_kind: current.run_kind,
                stage_key: input.stageKey ?? "synthesis",
                report_depth: current.report_depth,
                prompt_asset_key: PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY,
                prompt_version_id: resolvedPrompt.resolveResult.version_id,
                prompt_content_hash: resolvedPrompt.resolveResult.content_hash,
              },
            },
            policy_context_json: createManagedExecutionPolicy("project_research", true),
            risk_level: "low",
          },
        });
        const job = await new PgJobQueueRepository(db).enqueue({
          job_type: "agent_run",
          space_id: spaceId,
          user_id: userId,
          agent_id: current.agent_id,
          payload: { run_id: run.id },
        });
        const now = new Date().toISOString();
        current.synthesis_run_id = run.id;
        current.synthesis_progress = {
          run_id: run.id,
          run_status: run.status,
          job_id: job.id,
          job_status: job.status,
          job_attempts: job.attempts,
          job_heartbeat_at: dateIso(job.heartbeat_at),
          job_updated_at: dateIso(job.updated_at),
          run_updated_at: dateIso(run.updated_at),
          last_event_at: null,
          last_event_type: null,
          queued_at: run.created_at ?? now,
          started_at: run.started_at ?? null,
          updated_at: now,
          message: run.status === "running"
            ? "The synthesis agent is writing the structured research report from the approved corpus."
            : "The synthesis run is queued and waiting for an agent worker to pick it up.",
        };
        if (input.stageKey === "synthesis_revision" && current.synthesis_critique) {
          current.synthesis_critique.status = "queued";
          current.synthesis_critique.run_id = run.id;
        }
      },
      stepOverrides: (current) => [
        { seq: 0, status: "done" },
        { seq: 1, status: "done" },
        { seq: 2, status: "done" },
        { seq: 3, status: "active", detail: { run_id: current.synthesis_run_id } },
        { seq: 4, status: "pending" },
      ],
      onStale: "noop",
    });
    if (!emptyMatrix) return result;
    const operation = await this.ports.operation(spaceId, operationId);
    if (!operation) return result;
    return this.completeWithoutReport(operation, researchState(operation.progress_json), {
      kind: "no_relevant_sources",
      message: "Screening completed, but no relevant or maybe material remained for synthesis.",
      reasonCode: "empty_approved_corpus",
      suggestions: ["Broaden the search query, inclusion scope, provider selection, or history window."],
    });
  }

  async queueCritique(input: QueueSynthesisStageInput): Promise<ResearchMutationResult> {
    return advanceResearchOperation(this.db, input.spaceId, input.operationId, {
      from: ["synthesis"],
      to: "synthesis",
      mutate: async ({ db, state }) => {
        const critique = state.synthesis_critique;
        if (!critique || critique.status !== "needs_queue") return false;
        const artifact = await db.query<{ content: string | null }>(
          `SELECT content FROM artifacts WHERE id=$1 AND space_id=$2 AND project_id=$3`,
          [critique.archive_artifact_id, input.spaceId, input.projectId],
        );
        if (!artifact.rows[0]?.content) throw new HttpError(500, "Synthesis critique report candidate is unavailable");
        const report = objectValue(JSON.parse(artifact.rows[0].content));
        const resolved = await resolveProjectResearchCritiquePrompt(db, {
          spaceId: input.spaceId,
          userId: input.userId,
          projectId: input.projectId,
          agentId: state.agent_id,
          researchQuestion: researchQueryText(state),
          researchScope: state.research_scope,
          reportDepth: state.report_depth,
          report,
          corpusSummary: critiqueCorpusSummary(report),
        });
        if (!resolved) throw new HttpError(500, "Project Research synthesis critique prompt is not resolvable");
        const run = await new PgRunRepository(db).createQueuedRunWithBudgetAdmission({
          agent_id: state.agent_id,
          space_id: input.spaceId,
          user_id: input.userId,
          mode: "live",
          run_type: "agent",
          trigger_origin: "system",
          project_id: input.projectId,
          runtime_profile_id: state.runtime_profile_id || null,
          prompt: `Critique the Project Research report for: ${researchQueryText(state)}`,
          instruction: resolved.instruction,
          capability_id: "research.brief_synthesize",
          capabilities_json: RESEARCH_SYNTHESIS_CAPABILITIES,
          contract_snapshot: {
            source: { kind: "workflow", id: input.workflowId },
            project_id: input.projectId,
            required_outputs_json: { artifact_types: [] },
            structured_output_json: RESEARCH_SYNTHESIS_CRITIQUE_OUTPUT_CONTRACT,
            workflow_input_json: {
              project_research: {
                workflow_id: input.workflowId,
                operation_id: input.operationId,
                run_kind: state.run_kind,
                stage_key: "synthesis_critique",
                critique_round: critique.round,
                report_run_id: critique.report_run_id,
                prompt_asset_key: PROJECT_RESEARCH_SYNTHESIS_CRITIQUE_PROMPT_KEY,
                prompt_version_id: resolved.resolveResult.version_id,
                prompt_content_hash: resolved.resolveResult.content_hash,
              },
            },
            policy_context_json: createManagedExecutionPolicy("project_research", true),
            risk_level: "low",
          },
        });
        const job = await new PgJobQueueRepository(db).enqueue({
          job_type: "agent_run",
          space_id: input.spaceId,
          user_id: input.userId,
          agent_id: state.agent_id,
          payload: { run_id: run.id },
        });
        critique.status = "queued";
        critique.run_id = run.id;
        state.synthesis_run_id = run.id;
        const now = new Date().toISOString();
        state.synthesis_progress = {
          run_id: run.id,
          run_status: run.status,
          job_id: job.id,
          job_status: job.status,
          job_attempts: job.attempts,
          queued_at: run.created_at ?? now,
          started_at: run.started_at ?? null,
          updated_at: now,
          message: "The synthesis draft is undergoing an adversarial evidence critique.",
        };
      },
      stepOverrides: (state) => [
        { seq: 0, status: "done" }, { seq: 1, status: "done" }, { seq: 2, status: "done" },
        { seq: 3, status: "active", detail: { run_id: state.synthesis_run_id, phase: "critique" } },
        { seq: 4, status: "pending" },
      ],
      onStale: "noop",
    });
  }

  async queueRevision(input: QueueSynthesisStageInput): Promise<ResearchMutationResult> {
    const operation = await this.ports.operation(input.spaceId, input.operationId);
    const state = operation ? researchState(operation.progress_json) : null;
    if (!state?.synthesis_critique || state.synthesis_critique.status !== "revision_needed") {
      return { applied: false, reason: "aborted" };
    }
    const context = state.synthesis_critique.issues
      .map((issue) => `${issue.severity}/${issue.kind}: ${issue.detail}${issue.affected_refs.length ? ` (${issue.affected_refs.join(", ")})` : ""}`)
      .join("\n");
    return this.queue({
      ...input,
      from: ["synthesis"],
      reuseExistingRun: false,
      stageKey: "synthesis_revision",
      critiqueContext: context,
    });
  }

  async recoverUnbound(spaceId: string, row: SynthesisOperationRow, state: ResearchOperationState): Promise<void> {
    if (state.synthesis_critique?.status === "needs_queue") {
      const actor = await this.ports.projectWriterActor(spaceId, row.project_id);
      if (!actor) return this.ports.failOperation(row, "Synthesis critique could not resolve a project writer");
      try {
        await this.queueCritique({ spaceId, userId: actor, projectId: row.project_id, operationId: row.id, workflowId: state.workflow_id });
      } catch (error) {
        await this.ports.failOperation(row, error instanceof Error ? error.message : "Failed to queue synthesis critique");
      }
      return;
    }
    if (state.synthesis_critique?.status === "revision_needed") {
      const actor = await this.ports.projectWriterActor(spaceId, row.project_id);
      if (!actor) return this.ports.failOperation(row, "Synthesis revision could not resolve a project writer");
      try {
        await this.queueRevision({ spaceId, userId: actor, projectId: row.project_id, operationId: row.id, workflowId: state.workflow_id });
      } catch (error) {
        await this.ports.failOperation(row, error instanceof Error ? error.message : "Failed to queue synthesis revision");
      }
      return;
    }
    const run = await this.db.query<{ id: string }>(
      `SELECT id FROM runs
        WHERE space_id=$1
          AND contract_snapshot_json->'workflow_input_json'->'project_research'->>'operation_id'=$2
          AND contract_snapshot_json->'workflow_input_json'->'project_research'->>'stage_key' IN ('synthesis','synthesis_revision','synthesis_critique')
        ORDER BY created_at DESC LIMIT 1`,
      [spaceId, row.id],
    );
    const runId = run.rows[0]?.id;
    if (!runId) {
      await this.ports.failOperation(row, "The synthesis stage has no synthesis run bound and none exists for this operation; retry synthesis");
      return;
    }
    state.synthesis_run_id = runId;
    await setResearchOperationState(this.db, row, state, deriveStepStates(state));
    await this.reconcileStage(spaceId, row, state);
  }

  async reconcileStage(spaceId: string, row: SynthesisOperationRow, state: ResearchOperationState): Promise<void> {
    const runId = state.synthesis_run_id!;
    const [run, job, event] = await Promise.all([
      this.db.query<{ status: string; created_at: unknown; started_at: unknown; updated_at: unknown }>(
        `SELECT status, created_at, started_at, updated_at FROM runs WHERE id=$1 AND space_id=$2`,
        [runId, spaceId],
      ),
      this.db.query<{ id: string; status: string; attempts: number; heartbeat_at: unknown; updated_at: unknown }>(
        `SELECT id, status, attempts, heartbeat_at, updated_at FROM jobs
          WHERE space_id=$1 AND job_type='agent_run' AND payload_json->>'run_id'=$2
          ORDER BY created_at DESC LIMIT 1`,
        [spaceId, runId],
      ),
      this.db.query<{ event_type: string; created_at: unknown }>(
        `SELECT event_type, created_at FROM run_events
          WHERE space_id=$1 AND run_id=$2
          ORDER BY created_at DESC, event_index DESC, id DESC LIMIT 1`,
        [spaceId, runId],
      ),
    ]);
    const value = run.rows[0];
    if (!value) {
      await this.ports.failOperation(row, "The queued synthesis run no longer exists; retry to queue a new synthesis run");
      return;
    }
    if (["succeeded", "degraded", "failed", "cancelled"].includes(value.status)) {
      await this.ports.reconcileCompletedRun(spaceId, runId);
      const after = await this.ports.operation(spaceId, row.id);
      const afterState = after ? researchState(after.progress_json) : null;
      if (after && !["completed", "failed", "cancelled"].includes(after.status)
        && afterState?.current_stage === "synthesis" && afterState.synthesis_run_id === runId) {
        await this.ports.failOperation(after, `Synthesis run finished with status ${value.status} but its output could not be applied to this operation; retry synthesis`);
      }
      return;
    }
    const now = new Date().toISOString();
    state.synthesis_progress = {
      run_id: runId,
      run_status: value.status,
      job_id: job.rows[0]?.id ?? null,
      job_status: job.rows[0]?.status ?? null,
      job_attempts: job.rows[0]?.attempts ?? null,
      job_heartbeat_at: dateIso(job.rows[0]?.heartbeat_at),
      job_updated_at: dateIso(job.rows[0]?.updated_at),
      run_updated_at: dateIso(value.updated_at),
      last_event_at: dateIso(event.rows[0]?.created_at),
      last_event_type: event.rows[0]?.event_type ?? null,
      queued_at: dateIso(value.created_at),
      started_at: dateIso(value.started_at),
      updated_at: now,
      message: value.status === "running"
        ? "The synthesis agent is writing the structured research report from the approved corpus."
        : "The synthesis run is queued and waiting for an agent worker to pick it up.",
    };
    state.heartbeat_at = now;
    await setResearchOperationState(this.db, row, state, deriveStepStates(state));
  }

  async stageCandidate(input: {
    spaceId: string; projectId: string; workflowId: string; operationId: string; runId: string;
    report: Record<string, unknown>; archiveArtifactId: string;
  }): Promise<void> {
    await withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, input.spaceId, input.projectId);
      const locked = await db.query<SynthesisOperationRow>(
        `SELECT id,space_id,project_id,status,progress_json FROM project_operations
          WHERE space_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        [input.spaceId, input.projectId, input.operationId],
      );
      const operation = locked.rows[0];
      if (!operation) throw new HttpError(404, "Research operation not found");
      const state = researchState(operation.progress_json);
      if (state.synthesis_critique?.report_run_id === input.runId) return;
      const previous = state.synthesis_critique;
      const numberedReport = await assignReportReferenceIds(db, input.spaceId, input.report);
      await db.query(
        `UPDATE artifacts SET content=$1, updated_at=$2 WHERE id=$3 AND space_id=$4 AND project_id=$5`,
        [JSON.stringify(numberedReport), new Date().toISOString(), input.archiveArtifactId, input.spaceId, input.projectId],
      );
      if (previous && previous.archive_artifact_id !== input.archiveArtifactId) {
        await db.query(
          `UPDATE artifacts SET surface_role='system_archive',
             metadata_json=COALESCE(metadata_json,'{}'::jsonb) || $1::jsonb, updated_at=$2
           WHERE id=$3 AND space_id=$4 AND project_id=$5`,
          [JSON.stringify({ superseded_by_run_id: input.runId }), new Date().toISOString(), previous.archive_artifact_id, input.spaceId, input.projectId],
        );
      }
      state.synthesis_run_id = null;
      state.synthesis_critique = {
        status: "needs_queue",
        run_id: null,
        report_run_id: input.runId,
        archive_artifact_id: input.archiveArtifactId,
        round: previous?.status === "revision_needed" || previous?.revision_count === 1 ? 1 : 0,
        revision_count: previous?.revision_count ?? 0,
        issues: [],
        all_issues: previous?.all_issues ?? [],
        artifact_ids: previous?.artifact_ids ?? [],
      };
      state.synthesis_progress = {
        run_id: input.runId,
        run_status: "succeeded",
        queued_at: null,
        started_at: null,
        updated_at: new Date().toISOString(),
        message: "The report draft is complete and queued for an adversarial critique pass.",
      };
      await setResearchOperationState(db, operation, state, deriveStepStates(state));
    });
  }

  async persistCompleted(input: {
    spaceId: string; projectId: string; workflowId: string; operationId: string; runId: string;
    report: Record<string, unknown>; archiveArtifactId: string;
  }): Promise<void> {
    await lockActiveProjectForMutation(this.db, input.spaceId, input.projectId);
    const locked = await this.db.query<SynthesisOperationRow>(
      `SELECT id,space_id,project_id,status,progress_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
      [input.spaceId, input.projectId, input.operationId],
    );
    const operation = locked.rows[0];
    if (!operation) throw new HttpError(404, "Research operation not found");
    const state = researchState(operation.progress_json);
    const materialized = await new ProjectResearchReportMaterializer(this.db).materialize({
      spaceId: input.spaceId, projectId: input.projectId, workflowId: input.workflowId,
      operationId: input.operationId, synthesisRunId: input.runId, runKind: state.run_kind,
      researchQuestion: state.research_question, researchQuestionVersion: state.research_question_version,
      report: input.report, archiveArtifactId: input.archiveArtifactId,
      evidenceMatrixArtifactId: optionalString(state.matrix_artifact_id),
    });
    state.artifact_ids = unique([...state.artifact_ids, input.archiveArtifactId]);
    state.synthesis_run_id = input.runId;
    // Checkpoint reform: when idea_review does not gate, this
    // stage is under way rather than waiting on anybody. Writing
    // `waiting_review`/`blocked` first and waiving after would advertise a
    // review nobody will be asked for — and if the reconciler is not running,
    // the operation would sit that way indefinitely.
    const gated = checkpointBlocks("idea_review");
    state.current_stage = "idea_review";
    state.stage_state = gated ? "waiting_review" : "running";
    await setResearchOperationState(this.db, operation, state, [
      { seq: 0, status: "done" }, { seq: 1, status: "done" }, { seq: 2, status: "done" },
      { seq: 3, status: "done", detail: { run_id: input.runId, report_id: materialized.id } },
      {
        seq: 4,
        status: gated ? "blocked" : "active",
        detail: { checkpoint_type: "idea_review", report_id: materialized.id },
      },
    ]);
    const checkpointId = await this.ports.createCheckpoint(this.db, input.spaceId, input.projectId, input.workflowId, operation.id, "idea_review", {
      operation_id: operation.id, run_kind: state.run_kind, report_id: materialized.id,
      idea_count: materialized.ideaCount, requires_batch_decision: true,
    });
    // Waived after the state write, so a dropped write replays rather than
    // leaving a waived checkpoint with no advance behind it;
    // `reconcileIdeaReviewStage` carries the operation onward next tick.
    await recordInformationalIdeaReview(this.db, input.spaceId, checkpointId);
  }

  async reconcileCompletedDraft(input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    operation: SynthesisOperationRow;
    runId: string;
    output: unknown;
  }): Promise<void> {
    const synthesisResult = inspectSynthesisResult(input.output);
    if (synthesisResult?.kind === "invalid") {
      await this.ports.failOperation(input.operation, synthesisResult.message, { code: "synthesis_output_invalid" });
      return;
    }
    // input.output is the full canonical run-output envelope (schema_version:
    // "run_output.v1" wrapping the actual result under `.result`); read
    // through that wrapper or materialization is always undefined.
    const materialization = runOutputResult(input.output).materialization;
    const artifacts: ResearchArtifactRecord[] = [];
    for (const item of Array.isArray(materialization) ? materialization : []) {
      const artifactId = optionalString(objectValue(item).artifact_id);
      if (!artifactId) continue;
      const artifact = await this.db.query<{ id: string; artifact_type: string; content: string | null }>(
        `SELECT id, artifact_type, content FROM artifacts WHERE id=$1 AND space_id=$2 AND project_id=$3`,
        [artifactId, input.spaceId, input.projectId],
      );
      if (artifact.rows[0]) artifacts.push(artifact.rows[0]);
    }
    const validation = await validateResearchArtifacts(artifacts);
    if (!validation.ok) {
      await this.recordValidationFailure(input.spaceId, input.runId, validation.failure);
      await this.ports.failOperation(input.operation, validation.failure.message, {
        code: validation.failure.code,
        diagnostics: validation.failure.diagnostics,
      });
      return;
    }
    await this.stageCandidate({
      spaceId: input.spaceId,
      projectId: input.projectId,
      workflowId: input.workflowId,
      operationId: input.operation.id,
      runId: input.runId,
      report: validation.report,
      archiveArtifactId: validation.archive.id,
    });
    const actor = await this.ports.projectWriterActor(input.spaceId, input.projectId);
    if (!actor) {
      await this.ports.failOperation(input.operation, "Research synthesis critique requires a project writer");
      return;
    }
    try {
      await this.queueCritique({
        spaceId: input.spaceId,
        userId: actor,
        projectId: input.projectId,
        operationId: input.operation.id,
        workflowId: input.workflowId,
      });
    } catch (error) {
      await this.ports.failOperation(input.operation, error instanceof Error ? error.message : "Failed to queue synthesis critique");
    }
  }

  async reconcileCompletedCritique(input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    operation: SynthesisOperationRow;
    runId: string;
    userId: string | null;
    output: unknown;
  }): Promise<void> {
    if (!input.userId) {
      await this.ports.failOperation(input.operation, "Synthesis critique could not resolve a project writer");
      return;
    }
    // input.output is the full canonical run-output envelope; verdict/issues
    // live under `.result`, not at the envelope's top level.
    const result = critiqueResult(runOutputResult(input.output));
    if (!result) {
      await this.ports.failOperation(input.operation, "Synthesis critique output is invalid", {
        code: "synthesis_critique_output_invalid",
      });
      return;
    }
    let revisionNeeded = false;
    await withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, input.spaceId, input.projectId);
      const locked = await db.query<SynthesisOperationRow>(
        `SELECT id,space_id,project_id,status,progress_json
           FROM project_operations WHERE space_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        [input.spaceId, input.projectId, input.operation.id],
      );
      const operation = locked.rows[0];
      if (!operation) throw new HttpError(404, "Research operation not found");
      const state = researchState(operation.progress_json);
      const critique = state.synthesis_critique;
      if (!critique || critique.run_id !== input.runId || critique.status === "completed") return;
      const critiqueArtifactId = await ensureCritiqueArtifact(db, {
        ...input,
        userId: input.userId!,
        result,
        round: critique.round,
      });
      critique.verdict = result.verdict;
      critique.issues = result.issues;
      critique.all_issues = [...critique.all_issues, ...result.issues];
      critique.artifact_ids = unique([...critique.artifact_ids, critiqueArtifactId]);
      state.artifact_ids = unique([...state.artifact_ids, critiqueArtifactId]);
      const hasCritical = result.issues.some((issue) => issue.severity === "critical");
      revisionNeeded = state.report_depth === "full"
        && result.verdict === "revise"
        && hasCritical
        && critique.revision_count < 1;
      if (revisionNeeded) {
        critique.status = "revision_needed";
        critique.revision_count = 1;
        state.synthesis_run_id = null;
        state.synthesis_progress = {
          run_id: input.runId,
          run_status: "succeeded",
          queued_at: null,
          started_at: null,
          updated_at: new Date().toISOString(),
          message: "The critique found a critical issue; one bounded synthesis revision is queued.",
        };
        await setResearchOperationState(db, operation, state, deriveStepStates(state));
        return;
      }

      const artifact = await db.query<{ content: string | null }>(
        `SELECT content FROM artifacts WHERE id=$1 AND space_id=$2 AND project_id=$3`,
        [critique.archive_artifact_id, input.spaceId, input.projectId],
      );
      if (!artifact.rows[0]?.content) throw new HttpError(500, "Critiqued synthesis report is unavailable");
      const report = objectValue(JSON.parse(artifact.rows[0].content));
      report.limitations = appendCritiqueLimitations(
        report.limitations,
        critique.all_issues,
        critique.round > 0 || state.report_depth === "quick",
      );
      await db.query(
        `UPDATE artifacts SET content=$1, updated_at=$2 WHERE id=$3 AND space_id=$4`,
        [JSON.stringify(report), new Date().toISOString(), critique.archive_artifact_id, input.spaceId],
      );
      critique.status = "completed";
      state.synthesis_run_id = input.runId;
      await setResearchOperationState(db, operation, state, deriveStepStates(state));
      await new ProjectResearchSynthesisCoordinator(db, this.ports).persistCompleted({
        spaceId: input.spaceId,
        projectId: input.projectId,
        workflowId: input.workflowId,
        operationId: input.operation.id,
        runId: critique.report_run_id,
        report,
        archiveArtifactId: critique.archive_artifact_id,
      });
    });
    if (!revisionNeeded) return;
    try {
      await this.queueRevision({
        spaceId: input.spaceId,
        userId: input.userId,
        projectId: input.projectId,
        operationId: input.operation.id,
        workflowId: input.workflowId,
      });
    } catch (error) {
      const operation = await this.ports.operation(input.spaceId, input.operation.id);
      if (operation) {
        await this.ports.failOperation(
          operation,
          error instanceof Error ? error.message : "Failed to queue synthesis revision",
        );
      }
    }
  }

  private async recordValidationFailure(
    spaceId: string,
    runId: string,
    failure: ResearchArtifactValidationFailure,
  ): Promise<void> {
    process.stderr.write(`[project-research.synthesis] validation_failed ${JSON.stringify({
      run_id: runId, code: failure.code, message: failure.message, diagnostics: failure.diagnostics,
    })}\n`);
    const repository = new PgRunRepository(this.db);
    try {
      await repository.markRunDegraded({
        run_id: runId, space_id: spaceId, completed_at: new Date().toISOString(),
        error_code: failure.code, error_message: failure.message, diagnostics: failure.diagnostics,
      });
    } catch {
      // The operation error remains authoritative.
    }
    try {
      await repository.appendRunEvent({
        run_id: runId, space_id: spaceId, event_type: "validation_completed", status: "failed",
        summary: "Project Research synthesis artifact validation failed.",
        error_code: failure.code, error_message: failure.message, trust_level: "high",
        metadata_json: { validation_layer: "project_research_synthesis", ...failure.diagnostics },
      });
    } catch {
      // Diagnostic event persistence is best effort.
    }
  }

  async completeWithoutReport(
    operation: SynthesisOperationRow,
    state: ResearchOperationState,
    outcome: {
      kind: "no_relevant_sources" | "no_coherent_synthesis";
      message: string;
      reasonCode: string;
      suggestions: string[];
    },
  ): Promise<ResearchMutationResult> {
    const result = await advanceResearchOperation(this.db, operation.space_id, operation.id, {
      from: [researchStage(state.current_stage)],
      to: "complete",
      mutate: ({ state: current }) => {
        current.empty_result = {
          kind: outcome.kind,
          source_item_count: current.source_item_ids.length,
          ...(outcome.kind === "no_relevant_sources" ? { relevant_source_count: 0 } : {}),
          detected_at: new Date().toISOString(),
          message: outcome.message,
          reason_code: outcome.reasonCode,
          suggestions: outcome.suggestions,
        };
        current.stage_state = "skipped";
        current.monitoring_active = true;
        current.heartbeat_at = new Date().toISOString();
      },
      stepOverrides: [
        { seq: 0, status: "done" }, { seq: 1, status: "done" }, { seq: 2, status: "done" },
        { seq: 3, status: "skipped", detail: { outcome: outcome.kind, reason_code: outcome.reasonCode } },
        { seq: 4, status: "skipped" },
      ],
      onStale: "noop",
    });
    if (result.applied && result.state) {
      await this.ports.setWorkflowMonitoring(operation.space_id, operation.project_id, state.workflow_id, result.state);
    }
    return result;
  }
}

export function researchQueryText(state: ResearchOperationState): string {
  return state.research_question || "approved research corpus";
}

function critiqueCorpusSummary(report: Record<string, unknown>): string {
  const sources = Array.isArray(report.sources) ? report.sources : [];
  const titles = sources
    .map((source) => typeof objectValue(source).title === "string" ? String(objectValue(source).title) : null)
    .filter((title): title is string => Boolean(title));
  return `${sources.length} report sources; ${titles.slice(0, 20).join(" | ") || "no titled sources"}`;
}

type SynthesisResultInspection =
  | { kind: "succeeded" }
  | { kind: "invalid"; message: string };

function inspectSynthesisResult(value: unknown): SynthesisResultInspection {
  const output = objectValue(value);
  return output.status === "succeeded"
    ? { kind: "succeeded" }
    : { kind: "invalid", message: "Synthesis output status must be succeeded" };
}

type CritiqueIssue = NonNullable<ResearchOperationState["synthesis_critique"]>["issues"][number];
type CritiqueResult = { verdict: "pass" | "revise"; issues: CritiqueIssue[] };

function critiqueResult(value: unknown): CritiqueResult | null {
  const output = objectValue(value);
  const verdict = optionalString(output.verdict);
  if (verdict !== "pass" && verdict !== "revise") return null;
  if (!Array.isArray(output.issues)) return null;
  const issues: CritiqueIssue[] = [];
  for (const item of output.issues) {
    const issue = objectValue(item);
    const severity = optionalString(issue.severity);
    const kind = optionalString(issue.kind);
    const detail = optionalString(issue.detail);
    if (!severity || !["critical", "major", "minor"].includes(severity)
      || !kind || !["cherry_picking", "missing_contradiction", "unsupported_claim", "alternative_explanation", "overreach"].includes(kind)
      || !detail || !Array.isArray(issue.affected_refs)) return null;
    const affectedRefs = stringArray(issue.affected_refs);
    if (affectedRefs.some((ref) => !/^ref-[0-9]+$/.test(ref))) return null;
    issues.push({
      severity: severity as CritiqueIssue["severity"],
      kind: kind as CritiqueIssue["kind"],
      detail,
      affected_refs: affectedRefs,
    });
  }
  return { verdict, issues };
}

function appendCritiqueLimitations(value: unknown, issues: CritiqueIssue[], unresolvedCritical: boolean): string[] {
  const limitations = stringArray(value);
  for (const issue of issues) {
    const prefix = issue.severity === "critical" && unresolvedCritical ? "[unresolved critique] " : "[critique] ";
    // Square brackets, not parentheses: the reader's citation regex
    // (ReadOnlyTiptapReader.tsx) only turns "[...ref-N...]" groups into
    // clickable references, matching the convention every other section
    // uses (reportProjection.ts's refs() helper). Parenthesized refs here
    // rendered as inert text.
    const refs = issue.affected_refs.length ? ` [${issue.affected_refs.join(", ")}]` : "";
    const line = `${prefix}${issue.kind}: ${issue.detail}${refs}`;
    if (!limitations.includes(line)) limitations.push(line);
  }
  return limitations;
}

async function ensureCritiqueArtifact(db: Queryable, input: {
  spaceId: string;
  projectId: string;
  workflowId: string;
  operation: SynthesisOperationRow;
  runId: string;
  userId: string;
  result: CritiqueResult;
  round: number;
}): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM artifacts WHERE space_id=$1 AND run_id=$2 AND artifact_type='research_critique' LIMIT 1`,
    [input.spaceId, input.runId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO artifacts (
       id,space_id,run_id,project_id,artifact_type,surface_role,title,content,mime_type,
       exportable,export_formats_json,canonical_format,preview,created_at,updated_at,
       metadata_json,visibility,owner_user_id,trust_level
     ) VALUES ($1,$2,$3,$4,'research_critique','operational',$5,$6,'application/json',
       true,'["json"]'::jsonb,'json',false,$7,$7,$8::jsonb,'private',$9,'high')`,
    [
      id,
      input.spaceId,
      input.runId,
      input.projectId,
      `Research synthesis critique · round ${input.round + 1}`,
      JSON.stringify({ schema_version: "research_critique.v1", round: input.round, ...input.result }),
      now,
      JSON.stringify({
        project_research_operation_id: input.operation.id,
        project_research_workflow_id: input.workflowId,
      }),
      input.userId,
    ],
  );
  return id;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function evidenceMatrixRowCount(
  db: Queryable,
  spaceId: string,
  projectId: string,
  artifactId: string,
): Promise<number> {
  const result = await db.query<{ content: string | null }>(
    `SELECT content FROM artifacts
      WHERE id=$1 AND space_id=$2 AND project_id=$3 AND artifact_type='evidence_matrix'
      LIMIT 1`,
    [artifactId, spaceId, projectId],
  );
  const content = result.rows[0]?.content;
  if (!content) throw new HttpError(500, "The approved evidence matrix is unavailable for synthesis");
  try {
    const rows = objectValue(JSON.parse(content)).rows;
    if (!Array.isArray(rows)) throw new Error("rows is not an array");
    return rows.length;
  } catch {
    throw new HttpError(500, "The approved evidence matrix is invalid for synthesis");
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
