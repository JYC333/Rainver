import type { Pool } from "../../../db/pool.js";
import { getDbPool } from "../../../db/pool.js";
import type { ServerConfig } from "../../../config.js";
import { HttpError, withDbTransaction, optionalString } from "../../routeUtils/common.js";
import type { SpaceUserIdentity } from "../../routeUtils/common.js";
import {
  JobDeferredError,
  type JobHandlerRegistry,
  type JobEnvelopeForHandler,
  type JobHandlerResult,
} from "../../jobs/handlerRegistry.js";
import { RoomService } from "../../rooms/service.js";
import { isConversationTurnInProgressError } from "../../sessions/conversationRuntimeSessionRepository.js";
import { ProjectResearchQuestionAssessmentRepository } from "../questionAssessmentRepository.js";
import { ProjectResearchQuestionRefineService } from "../questionRefineService.js";
import { AdaptiveQueryOrchestrator } from "../../research/queryPlanning/adaptiveQueryOrchestrator.js";
import { ResearchMonitorMaterializer } from "../../research/discovery/monitorMaterializer.js";
import { ProjectResearchOrchestrator } from "../orchestrator.js";
import { ProjectOperationRepository } from "../../projects/projectOperationRepository.js";
import { SCREENING_AUTO_CONTINUE_CORPUS_LIMIT } from "../researchCheckpointPolicy.js";

export const RESEARCH_PIPELINE_START_JOB = "research_pipeline_start";

/** Room conversation turns are typically busy for well under this window. */
const TURN_BUSY_RETRY_DELAY_MS = 2_000;

/**
 * Default provider set and search budget for a Room-invoked acquisition
 * start (no per-call tuning surface — room-advancement-reliability-plan
 * Phase 4 decision 5). Mirrors `ResearchSetupDialog`'s own untouched
 * defaults: `web_search` is deliberately excluded, since there is no single
 * unambiguous credential to select on the model's behalf. Auto-selecting
 * these per invocation is a recorded follow-up (backlog R1.2), not this
 * phase.
 */
const DEFAULT_PROVIDERS: Array<"arxiv" | "openalex" | "semantic_scholar" | "web_search"> = ["arxiv", "openalex"];
const DEFAULT_CANDIDATE_BUDGET = 1000;

const SYNTHETIC_ASSESSMENT_MESSAGE =
  "Assess this question for acquisition readiness (FINER: feasible, interesting, novel, ethical, relevant) and prepare it for research acquisition. No additional scope narrowing beyond the question itself.";

export function registerResearchAcquisitionPipelineHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  registry.register(RESEARCH_PIPELINE_START_JOB, async (job): Promise<JobHandlerResult> => {
    return new ResearchAcquisitionPipelineRunner(pool, config).run(job);
  });
}

interface PipelinePayload {
  threadId: string;
  projectId: string;
  /** Caller-set scope; the defaults below apply when the caller said nothing. */
  maxItems: number | null;
  since: string | null;
  originRoomId: string | null;
  originSessionId: string | null;
  /** Identifies *this* pipeline run, so its outcome is reported even when an
   *  earlier run for the same Thread already reported an identical one. */
  jobId: string;
}

/** True for a domain/semantic rejection (bad input, business-rule conflict);
 * false for anything that should fall through to the job queue's own
 * attempt/backoff retry. Semantic failures are never auto-retried — retrying
 * a bad question or a genuine 409 conflict a hundred times does not change
 * the outcome (plan Phase 4 decision 5). */
function isDomainError(error: unknown): error is HttpError {
  return error instanceof HttpError && error.statusCode < 500;
}

/** Test-only seam for the one dependency the production path never
 * overrides: `AdaptiveQueryOrchestrator`'s live intent-planning/preview-search
 * providers. Everything else the pipeline touches (assessment session,
 * question refinement, strategy activation, initial intake, Room
 * continuation) runs against real Postgres in tests the same as in
 * production; only the LLM-planning + live-search stage needs a fake. */
export interface ResearchAcquisitionPipelineTestDeps {
  adaptiveQueryDependencies?: ConstructorParameters<typeof AdaptiveQueryOrchestrator>[2];
}

export class ResearchAcquisitionPipelineRunner {
  constructor(
    private readonly pool: Pool,
    private readonly config: ServerConfig,
    private readonly testDeps: ResearchAcquisitionPipelineTestDeps = {},
  ) {}

  async run(job: JobEnvelopeForHandler): Promise<JobHandlerResult> {
    const payload = this.parsePayload(job.payload, job.job_id);
    const identity: SpaceUserIdentity = { spaceId: job.space_id, userId: requireUserId(job) };

    const outcome = await this.runPipeline(identity, payload);
    if (outcome.status !== "started") await this.recordFailedAttempt(identity, payload, outcome);
    await this.postOutcome(identity, payload, outcome);
    return outcome as unknown as JobHandlerResult;
  }

  private parsePayload(raw: Record<string, unknown>, jobId: string): PipelinePayload {
    const threadId = optionalString(raw.thread_id);
    const projectId = optionalString(raw.project_id);
    if (!threadId || !projectId) {
      throw new Error(`${RESEARCH_PIPELINE_START_JOB} requires thread_id and project_id`);
    }
    return {
      threadId,
      projectId,
      originRoomId: optionalString(raw.origin_room_id) ?? null,
      originSessionId: optionalString(raw.origin_session_id) ?? null,
      maxItems: typeof raw.max_items === "number" && Number.isInteger(raw.max_items) && raw.max_items > 0
        ? raw.max_items
        : null,
      since: optionalString(raw.since) ?? null,
      jobId,
    };
  }

  private async runPipeline(
    identity: SpaceUserIdentity,
    payload: PipelinePayload,
  ): Promise<Record<string, unknown>> {
    const thread = await this.pool.query<{ statement: string }>(
      `SELECT statement FROM inquiry_threads
        WHERE object_id=$1 AND space_id=$2 AND project_id=$3
          AND kind='question' AND lifecycle_status='active'`,
      [payload.threadId, identity.spaceId, payload.projectId],
    );
    const statement = thread.rows[0]?.statement;
    if (!statement) {
      return { status: "stage_failed", stage: "assessment", thread_id: payload.threadId, reason: "The Inquiry Thread no longer exists or is no longer an active Question" };
    }

    let contextVersionId: string;
    try {
      contextVersionId = await this.resolveContextVersion(identity, payload, statement);
    } catch (error) {
      if (isDomainError(error)) {
        return { status: "stage_failed", stage: "assessment", thread_id: payload.threadId, reason: error.message };
      }
      throw error;
    }

    let strategyId: string;
    try {
      strategyId = await this.resolveStrategy(identity, payload, contextVersionId);
    } catch (error) {
      if (isDomainError(error) && /has not passed question assessment/.test(error.message)) {
        return { status: "assessment_not_passed", thread_id: payload.threadId, reason: error.message };
      }
      if (isDomainError(error)) {
        return { status: "stage_failed", stage: "evaluate", thread_id: payload.threadId, reason: error.message };
      }
      throw error;
    }

    try {
      // Materializing the selected query into a Source channel/binding and
      // activating the strategy are one call in this domain
      // (`ResearchMonitorMaterializer.materialize`, which itself calls
      // `ResearchStrategyActivationService.activate` once materialization
      // succeeds) — not two separate steps. Safe to call unconditionally even
      // when a reused strategy is already materialized/active: both the
      // channel lookup and the activation it performs are themselves
      // idempotent.
      await new ResearchMonitorMaterializer(this.pool, this.config).materialize(identity, strategyId, {
        providerKeys: DEFAULT_PROVIDERS,
        activationReason: "initial",
      });
    } catch (error) {
      if (isDomainError(error)) {
        return { status: "stage_failed", stage: "activate", thread_id: payload.threadId, reason: error.message };
      }
      throw error;
    }

    let operationId: string;
    try {
      const started = await new ProjectResearchOrchestrator(this.pool, this.config).startInitialIntake(identity, payload.projectId, {
        thread_id: payload.threadId,
        query_strategy_id: strategyId,
        // A date floor makes this a bounded range, which is also what leaves
        // an earlier-history extension something to extend.
        ...(payload.since
          ? { history_mode: "bounded_range" as const, from: payload.since, to: new Date().toISOString() }
          : { history_mode: "all_available" as const }),
        // The whole of a source's history is a number nobody has seen and
        // nobody agreed to: unbounded, this ingested 873 documents and put
        // every one of them through an LLM classification — hours of work
        // and a million tokens — with no confirmation and nothing on screen.
        // The walk is newest-first and the budget is operation-wide, so this
        // buys the most recent `SCREENING_AUTO_CONTINUE_CORPUS_LIMIT` items
        // and stops. Earlier history remains reachable through the Extend
        // history path, which is a decision rather than a default.
        max_items: payload.maxItems ?? SCREENING_AUTO_CONTINUE_CORPUS_LIMIT,
        report_depth: "quick",
        question_refine_skipped: false,
      });
      operationId = (started as { operation: { id: string } }).operation.id;
    } catch (error) {
      // Every domain failure reports its own message. Folding 409s into one
      // "research is already running" line told the user — and the Agent
      // relaying it — something that was not true of any 409 but one, and
      // sent both down a diagnosis that had nothing to do with the failure.
      if (isDomainError(error)) {
        return { status: "stage_failed", stage: "start_intake", thread_id: payload.threadId, reason: error.message };
      }
      throw error;
    }

    if (payload.originRoomId && payload.originSessionId) {
      await this.pool.query(
        `UPDATE project_operations SET progress_json = progress_json || $1::jsonb
          WHERE id=$2 AND space_id=$3`,
        [JSON.stringify({ origin_room_id: payload.originRoomId, origin_session_id: payload.originSessionId }), operationId, identity.spaceId],
      );
    }

    return {
      status: "started",
      thread_id: payload.threadId,
      operation_id: operationId,
      // What the person is owed before it runs, not after it fails: roughly
      // how much matched, and how much of it this pass will actually read.
      screening_cap: payload.maxItems ?? SCREENING_AUTO_CONTINUE_CORPUS_LIMIT,
      matched_estimate: await this.estimateMatchedItems(identity, strategyId),
    };
  }

  /** Reuses the Thread's existing assessment-session context version when one
   * exists; otherwise runs one automated FINER assessment turn. Whether that
   * assessment actually passes is decided by `evaluate()`'s own gate, not
   * here — this stage only produces a context version to evaluate. */
  private async resolveContextVersion(
    identity: SpaceUserIdentity,
    payload: PipelinePayload,
    statement: string,
  ): Promise<string> {
    const session = await new ProjectResearchQuestionAssessmentRepository(this.pool).getConversation(
      identity,
      payload.projectId,
      payload.threadId,
    );
    if (session?.research_context_version_id) return session.research_context_version_id;
    const result = await new ProjectResearchQuestionRefineService(this.pool, this.config).refine(identity, payload.projectId, {
      thread_id: payload.threadId,
      message: SYNTHETIC_ASSESSMENT_MESSAGE,
      research_question: statement,
    });
    return result.research_context_version_id;
  }

  /** Reuses an already-materialized strategy for this context version
   * (advance-to-done: a prior run that got past `evaluate` but failed later
   * resumes here instead of re-running query planning and live provider
   * search). Otherwise runs `evaluate`, whose own FINER gate is the sole
   * assessment-passed check in this pipeline. */
  private async resolveStrategy(
    identity: SpaceUserIdentity,
    payload: PipelinePayload,
    contextVersionId: string,
  ): Promise<string> {
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM research_query_strategies
        WHERE space_id=$1 AND project_id=$2 AND research_context_version_id=$3
          AND status IN ('materialized','selected')
        ORDER BY version DESC LIMIT 1`,
      [identity.spaceId, payload.projectId, contextVersionId],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const strategy = await new AdaptiveQueryOrchestrator(this.pool, this.config, this.testDeps.adaptiveQueryDependencies).evaluate(identity, {
      projectId: payload.projectId,
      researchContextVersionId: contextVersionId,
      providers: DEFAULT_PROVIDERS,
      candidateBudget: DEFAULT_CANDIDATE_BUDGET,
    });
    return strategy.id;
  }

  /**
   * A pipeline that stops before `startInitialIntake` never created an
   * Operation, so the attempt existed only inside `jobs.result_json` — the
   * Project's own surfaces (Pulse, the Research Area's runs, and
   * `research.list_operations`) all read Operations and showed nothing at
   * all, which reads as "it is still running". A terminal, managed Operation
   * records the attempt where the work is looked for.
   */
  private async recordFailedAttempt(
    identity: SpaceUserIdentity,
    payload: PipelinePayload,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    const reason = typeof outcome.reason === "string" ? outcome.reason : "The research pipeline did not start an acquisition.";
    const stage = typeof outcome.stage === "string" ? outcome.stage : String(outcome.status ?? "unknown");
    try {
      const thread = await this.pool.query<{ statement: string }>(
        `SELECT statement FROM inquiry_threads WHERE object_id=$1 AND space_id=$2`,
        [payload.threadId, identity.spaceId],
      );
      const statement = thread.rows[0]?.statement ?? "this Question";
      await new ProjectOperationRepository(this.pool).createManagedResearch(identity, payload.projectId, {
        title: `Research did not start: ${statement}`.slice(0, 256),
        intentText: reason,
        status: "failed",
        progress: {
          run_kind: "acquisition_attempt",
          thread_id: payload.threadId,
          failed_stage: stage,
          failure_reason: reason,
          outcome_status: outcome.status ?? null,
          pipeline_job_id: payload.jobId,
          ...(payload.originRoomId ? { origin_room_id: payload.originRoomId } : {}),
          ...(payload.originSessionId ? { origin_session_id: payload.originSessionId } : {}),
        },
        steps: [],
      });
    } catch (error) {
      // Recording the attempt must never turn a reported failure into an
      // unreported one; the Room message below is the primary channel.
      process.stderr.write(
        `[project-research] could not record the failed acquisition attempt for thread ${payload.threadId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /**
   * Roughly how much the selected query matches, from the counts adaptive
   * query planning already recorded while choosing it — no extra provider
   * call.
   *
   * The largest single provider's count, not the sum: providers overlap
   * heavily (the same paper is in arXiv and OpenAlex), so summing them
   * reported 2,065 for a query whose corpus was 873 — a number that read as
   * the scope having grown when it had just been capped at 200. The union is
   * at least the largest count and at most the sum; the larger of the two
   * errors is the one that misleads about size.
   */
  private async estimateMatchedItems(identity: SpaceUserIdentity, strategyId: string): Promise<number | null> {
    const rows = await this.pool.query<{ hits: number | null }>(
      `SELECT DISTINCT ON (plan.id) attempt.provider_hit_count AS hits
         FROM research_query_provider_plans plan
         JOIN research_query_attempts attempt ON attempt.provider_plan_id = plan.id
        WHERE plan.strategy_id = $1 AND plan.space_id = $2 AND plan.status = 'selected'
        ORDER BY plan.id, attempt.round DESC, attempt.sequence DESC`,
      [strategyId, identity.spaceId],
    );
    const counts = rows.rows.map((row) => Number(row.hits ?? 0)).filter((value) => Number.isFinite(value) && value > 0);
    if (counts.length === 0) return null;
    return Math.max(...counts);
  }

  private async postOutcome(
    identity: SpaceUserIdentity,
    payload: PipelinePayload,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    if (!payload.originRoomId || !payload.originSessionId) return;
    try {
      await withDbTransaction(this.pool, (client) =>
        new RoomService(this.config, this.pool).continueAfterDomainEventInTransaction(
          client,
          identity,
          payload.originRoomId!,
          payload.originSessionId!,
          // Keyed by the pipeline run, not the Thread: retrying the same
          // Thread is a new outcome to report, and keying by Thread made
          // every attempt after the first silently return the first one's
          // message — so a failed retry looked like no answer at all.
          { kind: "research_pipeline_outcome", key: `${payload.threadId}:${payload.jobId}`, payload: outcome },
        ),
      );
    } catch (error) {
      if (isConversationTurnInProgressError(error)) {
        throw new JobDeferredError("Room conversation turn is still busy", TURN_BUSY_RETRY_DELAY_MS);
      }
      process.stderr.write(
        `[project-research] pipeline outcome notification failed for thread ${payload.threadId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

function requireUserId(job: JobEnvelopeForHandler): string {
  if (!job.user_id) throw new Error(`${RESEARCH_PIPELINE_START_JOB} requires a user_id`);
  return job.user_id;
}
