import { assertResearchOperationChange } from "../researchCallAccess.js";
import { reconcileResearchCall } from "../researchProblemCalls.js";
import { agentOriginContinuation } from "../../rooms/discussionService.js";
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
import { RoomService, UNATTRIBUTED_CONTINUATION } from "../../rooms/service.js";
import { isConversationTurnInProgressError } from "../../sessions/conversationRuntimeSessionRepository.js";
import { AdaptiveQueryOrchestrator } from "../../research/queryPlanning/adaptiveQueryOrchestrator.js";
import { ResearchMonitorMaterializer } from "../../research/discovery/monitorMaterializer.js";
import { ProjectResearchOrchestrator } from "../orchestrator.js";
import { SCREENING_AUTO_CONTINUE_CORPUS_LIMIT } from "../researchCheckpointPolicy.js";

export const RESEARCH_PIPELINE_START_JOB = "research_pipeline_start";

/** Room conversation turns are typically busy for well under this window. */
const TURN_BUSY_RETRY_DELAY_MS = 2_000;

/**
 * Default provider set and search budget for a Room-invoked acquisition
 * start. There is no per-call tuning surface. Mirrors `ResearchSetupDialog`'s
 * untouched defaults: `web_search` is deliberately excluded, since there is no
 * single unambiguous credential to select on the model's behalf.
 */
const DEFAULT_PROVIDERS: Array<"arxiv" | "openalex" | "semantic_scholar" | "web_search"> = ["arxiv", "openalex"];
const DEFAULT_CANDIDATE_BUDGET = 1000;

export function registerResearchAcquisitionPipelineHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  registry.register(RESEARCH_PIPELINE_START_JOB, async (job): Promise<JobHandlerResult> => {
    return new ResearchAcquisitionPipelineRunner(pool, config).run(job);
  });
}

interface PipelinePayload {
  operationId:string;
  intentNote:string|null;
  originRunId:string|null;
  callRequestKey:string|null;
  expectedThreadVersion:number|null;
  threadId: string;
  projectId: string;
  /** Caller-set scope; the defaults below apply when the caller said nothing. */
  maxItems: number | null;
  since: string | null;
  originRoomId: string | null;
  originSessionId: string | null;
  /** The Room task group whose Agent started it (`StartResearchAcquisitionInput.originGroupId`). */
  originGroupId: string | null;
  /** Identifies *this* pipeline run, so its outcome is reported even when an
   *  earlier run for the same Thread already reported an identical one. */
  jobId: string;
  /** The outcome an earlier run of this job computed before its report was deferred. */
  recordedOutcome: Record<string, unknown> | null;
}

/** True for a domain/semantic rejection (bad input, business-rule conflict);
 * false for anything that should fall through to the job queue's own
 * attempt/backoff retry. Semantic failures are never auto-retried — retrying
 * a bad question or a genuine 409 conflict a hundred times does not change
 * the outcome. */
function isDomainError(error: unknown): error is HttpError {
  return error instanceof HttpError && error.statusCode < 500;
}

/** Test-only seam for the one dependency the production path never
 * overrides: `AdaptiveQueryOrchestrator`'s live intent-planning/preview-search
 * providers. Everything else the pipeline touches (assessment session,
 * question refinement, strategy activation, initial intake, Room
 * continuation) runs against real Postgres in tests the same as in
 * production; only the LLM-planning + live-search stage needs a fake. */
interface ResearchAcquisitionPipelineTestDeps {
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

    // A busy Room turn defers this job and the worker runs it again from the
    // top. The outcome is kept on the job, so the rerun only reports it:
    // running the pipeline again recorded another failed attempt, repeated
    // the query evaluation, and with `since` turned a started acquisition
    // into a 409 "already active" failure.
    const durable=await this.pool.query<{outcome:unknown}>(`SELECT payload_json->'pipeline_outcome' AS outcome FROM jobs WHERE id=$1 AND space_id=$2`,[payload.jobId,identity.spaceId]);
    const saved=durable.rows[0]?.outcome;
    const recorded = payload.recordedOutcome??(saved&&typeof saved==='object'?saved as Record<string,unknown>:null);
    let outcome:Record<string,unknown>;
    try{outcome=recorded??await this.runPipeline(identity,payload);}catch(error){
     if(job.attempts>=job.max_attempts)await this.recordFailedAttempt(identity,payload,{status:'stage_failed',stage:'preparation',reason:'Research preparation exhausted its execution retries; inspect the Job diagnostics'});
     throw error;
    }
    if (!recorded) {
      if (outcome.status !== "started") await this.recordFailedAttempt(identity, payload, outcome);
      await this.pool.query(
        `UPDATE jobs SET payload_json = payload_json || jsonb_build_object('pipeline_outcome', $3::jsonb), updated_at = now()
          WHERE id = $1 AND space_id = $2`,
        [job.job_id, identity.spaceId, JSON.stringify(outcome)],
      );
    }
    await this.postOutcome(identity, payload, outcome);
    return outcome as unknown as JobHandlerResult;
  }

  private parsePayload(raw: Record<string, unknown>, jobId: string): PipelinePayload {
    const threadId = optionalString(raw.thread_id);
    const projectId = optionalString(raw.project_id);
    const operationId = optionalString(raw.operation_id);
    // Queue admission binds every job to its Operation before it is enqueued.
    if (!threadId || !projectId || !operationId) {
      throw new Error(`${RESEARCH_PIPELINE_START_JOB} requires thread_id, project_id and operation_id`);
    }
    return {
      threadId,
      projectId,
      operationId,
      intentNote:optionalString(raw.intent_note),
      originRunId:optionalString(raw.origin_run_id),
      callRequestKey:optionalString(raw.call_request_key),
      expectedThreadVersion:typeof raw.expected_thread_version==="number"?raw.expected_thread_version:null,
      originRoomId: optionalString(raw.origin_room_id) ?? null,
      originSessionId: optionalString(raw.origin_session_id) ?? null,
      originGroupId: optionalString(raw.origin_group_id) ?? null,
      maxItems: typeof raw.max_items === "number" && Number.isInteger(raw.max_items) && raw.max_items > 0
        ? raw.max_items
        : null,
      since: optionalString(raw.since) ?? null,
      jobId,
      recordedOutcome: raw.pipeline_outcome && typeof raw.pipeline_outcome === "object" && !Array.isArray(raw.pipeline_outcome)
        ? raw.pipeline_outcome as Record<string, unknown>
        : null,
    };
  }

  private async runPipeline(
    identity: SpaceUserIdentity,
    payload: PipelinePayload,
  ): Promise<Record<string, unknown>> {
    await assertResearchOperationChange(this.pool,identity,payload.projectId,payload.operationId);
    const op=await this.pool.query<{status:string;progress_json:Record<string,unknown>}>(`SELECT status,progress_json FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3`,[payload.operationId,identity.spaceId,payload.projectId]);
    if(op.rows[0]?.progress_json.acquisition_preflight===true&&op.rows[0].progress_json.acquisition_job_id!==payload.jobId)return {status:'superseded',thread_id:payload.threadId,operation_id:payload.operationId,reason:'This preparation attempt was superseded'};
    if(!op.rows[0]||op.rows[0].status==='cancelled')return {status:'cancelled',thread_id:payload.threadId,operation_id:payload.operationId,reason:'Research invocation was cancelled before admission'};
    // Admission replaces the preflight progress. If it committed but the worker
    // stopped before saving `pipeline_outcome`, the rerun reports that start;
    // running the pipeline again would announce a false setup failure.
    if(op.rows[0].progress_json.acquisition_preflight!==true&&op.rows[0].status!=='failed')return {status:'started',thread_id:payload.threadId,operation_id:payload.operationId,screening_cap:payload.maxItems??SCREENING_AUTO_CONTINUE_CORPUS_LIMIT,matched_estimate:null};
    const thread = await this.pool.query<{ statement: string;version:number }>(
      `SELECT statement,version FROM inquiry_threads
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
      contextVersionId = await this.resolveContextVersion(identity, payload);
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

    if(payload.expectedThreadVersion!==null&&thread.rows[0]?.version!==payload.expectedThreadVersion)return {status:"stage_failed",stage:"start_intake",thread_id:payload.threadId,reason:"The initiating Thread version changed; request new research explicitly"};
    let operationId: string;
    try {
      const started = await new ProjectResearchOrchestrator(this.pool, this.config).startInitialIntake(identity, payload.projectId, {
        idempotency_key:payload.callRequestKey??`pipeline:${payload.jobId}`,
        ...(payload.intentNote?{problem_call:{gap:payload.intentNote,input_refs:[],output_expectation:"Return evidence, counterevidence, limits and remaining gaps"}}:{}),
        thread_id: payload.threadId,
        query_strategy_id: strategyId,
        // A date floor makes this a bounded range, which is also what leaves
        // an earlier-history extension something to extend.
        ...(payload.since
          ? { history_mode: "bounded_range" as const, from: payload.since, to: new Date().toISOString() }
          : { history_mode: "all_available" as const }),
        // The whole of a source's history is a number nobody has seen and
        // nobody agreed to. Do not ingest it unbounded. Every item would go
        // through an LLM classification with no confirmation and nothing on
        // screen.
        // The walk is newest-first and the budget is operation-wide, so this
        // buys the most recent `SCREENING_AUTO_CONTINUE_CORPUS_LIMIT` items
        // and stops. Earlier history remains reachable through the Extend
        // history path, which is a decision rather than a default.
        max_items: payload.maxItems ?? SCREENING_AUTO_CONTINUE_CORPUS_LIMIT,
        report_depth: "quick",
        question_refine_skipped: false,
      },{...(payload.originRunId?{runId:payload.originRunId}:{}),operationId:payload.operationId,jobId:payload.jobId});
      operationId = (started as { operation: { id: string } }).operation.id;
    } catch (error) {
      // Every domain failure reports its own message. Do not fold every 409
      // into "research is already running". That is true of one 409. The
      // other failures would be diagnosed as that one.
      if (isDomainError(error)) {
        return { status: "stage_failed", stage: "start_intake", thread_id: payload.threadId, reason: error.message };
      }
      throw error;
    }

    if (payload.originRoomId && payload.originSessionId) {
      await this.pool.query(
        `UPDATE project_operations SET progress_json = progress_json || $1::jsonb
          WHERE id=$2 AND space_id=$3`,
        [JSON.stringify({
          origin_room_id: payload.originRoomId,
          origin_session_id: payload.originSessionId,
          ...(payload.originGroupId ? { origin_group_id: payload.originGroupId } : {}),
        }), operationId, identity.spaceId],
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

  /** Optional FINER sessions stay available in Frame; a direct acquisition
   * prepares its own immutable accepted-Thread context without inventing scores. */
  private async resolveContextVersion(identity:SpaceUserIdentity,payload:PipelinePayload):Promise<string>{
    const row=await this.pool.query<{context_id:string|null}>(`SELECT progress_json->>'preparation_context_version_id' AS context_id FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3`,[payload.operationId,identity.spaceId,payload.projectId]);
    if(!row.rows[0]?.context_id)throw new HttpError(409,"Research preparation has no admitted problem context");
    return row.rows[0].context_id;
  }

  /** Reuses an already-materialized strategy for this context version
   * (advance-to-done: a prior run that got past `evaluate` but failed later
   * resumes here instead of re-running query planning and live provider
   * search). Otherwise evaluates the accepted-Thread context using the
   * internal permission/version-checked planning basis. */
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
    },{threadId:payload.threadId});
    return strategy.id;
  }

  /** A preparation failure ends its original bound Operation, so Pulse, the
   * Research records and `research.list_operations` show where it stopped. */
  private async recordFailedAttempt(
    identity: SpaceUserIdentity,
    payload: PipelinePayload,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(`UPDATE project_operations SET status='failed',version=version+1,progress_json=progress_json||jsonb_build_object('current_stage','failed','stage_state','failed','failed_stage','monitor_setup','pipeline_outcome',$3::jsonb,'error',jsonb_build_object('code','acquisition_preflight_failed','message',$4::text)),updated_at=now() WHERE id=$1 AND space_id=$2 AND status NOT IN ('cancelled','completed') AND progress_json->>'acquisition_job_id'=$5`,[payload.operationId,identity.spaceId,JSON.stringify(outcome),String(outcome.reason??'Research preparation did not complete'),payload.jobId]);
    await reconcileResearchCall(this.pool,identity.spaceId,payload.operationId);
  }

  /**
   * Roughly how much the selected query matches, from the counts adaptive
   * query planning already recorded while choosing it — no extra provider
   * call.
   *
   * The largest single provider's count, not the sum. Providers overlap
   * heavily (the same paper is in arXiv and OpenAlex). Do not sum them.
   * The sum reads as the scope having grown past the cap. The union is
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
      await withDbTransaction(this.pool, async (client) =>
        new RoomService(this.config, this.pool).continueAfterDomainEventInTransaction(
          client,
          identity,
          payload.originRoomId!,
          payload.originSessionId!,
          // Keyed by the pipeline run, not the Thread: retrying the same
          // Thread is a new outcome to report, and keying by Thread made
          // every attempt after the first silently return the first one's
          // message — so a failed retry looked like no answer at all.
          {
            kind: "research_pipeline_outcome",
            key: `${payload.threadId}:${payload.jobId}`,
            payload: outcome,
            // Started by an Agent's turn: its result is charged to that turn's container.
            // With no originating turn there is nothing to inherit: it reports
            // as unattended work.
            ...(payload.originGroupId ? await agentOriginContinuation(client, identity.spaceId, payload.originGroupId) : { cause: UNATTRIBUTED_CONTINUATION }),
          },
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
