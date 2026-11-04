import { problemSummaries } from "./problemReadModel.js";
import { contextReadableSql, referenceReadableSql, assertProblemReferences } from "./problemReferences.js";
import { problemCommandKey } from "./problemFacts.js";
import { ProblemWorkRequestSchema, ProblemCloseRoundRequestSchema, PROBLEM_STAGES, PROBLEM_STAGE_DEFINITIONS } from "@rainver/protocol";
import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectReadable,canWriteProject } from "../projects/access.js";
import { assertThreadReadable,readableThreadIds } from "./threadAccess.js";
import { checkProblemVersion, closeRoundFact, lockProblem, problemRound, refreshProblem, replayProblemCommand, saveProblemCommand, startPrimary } from "./problemFacts.js";
import { recordThreadWorkEvent, type ThreadEventProvenance } from "./threadWorkEvents.js";
function parse<T>(schema: {
  safeParse: (v: unknown) => {
    success: true;
    data: T;
  } | {
    success: false;
    error: {
      message: string;
    };
  };
}, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(422, r.error.message);
  return r.data;
}
export class InquiryProblemEngineService {
  constructor(private readonly db: Queryable) {}
  async projection(identity: SpaceUserIdentity, projectId: string, threadId: string, options: {
    limit?: number;
    before_step?: number;
    before_closeout?: number;
  } = {}): Promise<Record<string, unknown>> {
    const ownsTransaction = typeof (this.db as {
      release?: unknown;
    }).release !== "function";
    return withQueryableTransaction(this.db, async db => {
      if (ownsTransaction) await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
      await assertThreadReadable(db, identity, projectId, threadId, "read_content");
      if (!ownsTransaction) await db.query(`SELECT object_id FROM inquiry_threads WHERE object_id=$1 AND space_id=$2 FOR SHARE`, [threadId, identity.spaceId]);
      return new InquiryProblemEngineService(db).readProjection(identity, projectId, threadId, options);
    });
  }
  private async readProjection(identity: SpaceUserIdentity, projectId: string, threadId: string, options: {
    limit?: number;
    before_step?: number;
    before_closeout?: number;
  } = {}): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await assertThreadReadable(this.db, identity, projectId, threadId, "read_content");
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new HttpError(422, "limit must be 1..100");
    for (const cursor of [options.before_step, options.before_closeout]) if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new HttpError(422, "Invalid history cursor");
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
    const summary = (await problemSummaries(this.db, identity, projectId, [threadId])).get(threadId)!;
    const safeContext = contextReadableSql("s.context_refs", "$4", "s.space_id", "s.project_id");
    const steps = await this.db.query<Record<string, unknown>>(`SELECT s.*,left(s.note,4000) AS note,length(s.note)>4000 AS note_truncated FROM inquiry_thread_steps s WHERE s.thread_id=$1 AND s.space_id=$2 AND ($3::bigint IS NULL OR s.fact_order<$3) AND ${safeContext} ORDER BY s.fact_order DESC LIMIT $5`, [threadId, identity.spaceId, options.before_step ?? null, identity.userId, limit + 1]);
    const closeouts = await this.db.query<Record<string, unknown>>(`SELECT c.id,c.thread_id,c.round_number,c.method_version,c.iteration_id,c.created_at,
      CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.input_refs) ref WHERE NOT COALESCE(${referenceReadableSql("ref", "$4", "c.space_id", "c.project_id")},false)) THEN c.next_focus ELSE NULL END AS next_focus,
      CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.input_refs) ref WHERE NOT COALESCE(${referenceReadableSql("ref", "$4", "c.space_id", "c.project_id")},false)) THEN left(c.summary,4000) ELSE NULL END AS summary,
      CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.input_refs) ref WHERE NOT COALESCE(${referenceReadableSql("ref", "$4", "c.space_id", "c.project_id")},false)) THEN c.input_refs ELSE '[]'::jsonb END AS input_refs,
      EXISTS(SELECT 1 FROM jsonb_array_elements(c.input_refs) ref WHERE NOT COALESCE(${referenceReadableSql("ref", "$4", "c.space_id", "c.project_id")},false)) AS content_withheld,
      EXISTS(SELECT 1 FROM project_work_events e WHERE e.space_id=c.space_id AND e.subject_id=c.thread_id AND e.event_kind='thread.round_closeout_reverted' AND e.data_json->>'closeout_id'=c.id) AS compensated
      FROM inquiry_round_closeouts c WHERE c.thread_id=$1 AND c.space_id=$2 AND ($3::integer IS NULL OR c.round_number<$3) ORDER BY c.round_number DESC LIMIT $5`, [threadId, identity.spaceId, options.before_closeout ?? null, identity.userId, limit + 1]);
    const facts = await this.db.query<{
      stage: string;
      worked: boolean;
      has_outputs: boolean;
      running: boolean;
    }>(`SELECT s.method_stage AS stage,bool_or(s.work_kind IN ('record_work','assess_result','reference_result','link_task','close_round') AND s.round_number=$3) AS worked,
      bool_or(s.round_number=$3 AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.context_refs) r WHERE r->>'role'='output')) AS has_outputs,
      bool_or(s.slot='background' AND s.status='in_progress') AS running FROM inquiry_thread_steps s WHERE s.thread_id=$1 AND s.space_id=$2 AND ${safeContext} GROUP BY s.method_stage`, [threadId, identity.spaceId, summary.round_number, identity.userId]);
    const history: Record<string, unknown>[] = steps.rows.slice(0, limit).reverse();
    return {
      method_version: "problem_solving.v1",
      can_write:(await this.db.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 AND status='active'`,[projectId,identity.spaceId])).rowCount===1 && await canWriteProject(this.db,identity.spaceId,projectId,identity.userId) && (await readableThreadIds(this.db,identity,[threadId],"change")).has(threadId),
      thread_id: threadId,
      ...summary,
      stages: PROBLEM_STAGES.map(stage => ({
        stage,
        ...PROBLEM_STAGE_DEFINITIONS[stage],
        worked: facts.rows.find(s => s.stage === stage)?.worked ?? false,
        has_outputs: facts.rows.find(s => s.stage === stage)?.has_outputs ?? false,
        running: facts.rows.find(s => s.stage === stage)?.running ?? false
      })),
      steps: history,
      closeouts: closeouts.rows.slice(0, limit).reverse(),
      next_step_cursor: steps.rows.length > limit ? Number(history[0]!.fact_order) : null,
      next_closeout_cursor: closeouts.rows.length > limit ? Number(closeouts.rows[limit - 1]!.round_number) : null
    };
  }
  async recordWork(identity: SpaceUserIdentity, projectId: string, threadId: string, body: unknown, provenance?: ThreadEventProvenance, resultSource?:{operation_id:string;attempt:number;execution_id:string|null}, trustedCall?: string): Promise<Record<string, unknown>> {
    const input = parse(ProblemWorkRequestSchema, body);
    return withQueryableTransaction(this.db, async db => {
      const thread = await lockProblem(db, identity, projectId, threadId);
      await assertProblemReferences(db, identity, projectId, [...input.input_refs, ...input.output_refs]);
      const key = problemCommandKey(identity, input.idempotency_key, provenance, trustedCall);
      const request = {
          command: "work",
          ...(resultSource?{research_result:resultSource}:{}),
          ...input
        },
        replay = await replayProblemCommand(db, identity.spaceId, threadId, key, request);
      if (replay) return {
        ...replay,
        ...(await new InquiryProblemEngineService(db).projection(identity, projectId, threadId))
      };
      checkProblemVersion(thread, input);
      if (thread.blocked_reason) throw new HttpError(409, "Unblock the Thread before starting work");
      const round = await problemRound(db, identity.spaceId, threadId),
        stepId = await startPrimary(db, identity, projectId, threadId, input, round, input);
      if(resultSource){
       const bound=await db.query(`SELECT id FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND research_call_json->>'thread_id'=$4 AND research_attempt=$5 AND current_execution_id IS NOT DISTINCT FROM $6::varchar AND status IN ('completed','failed','cancelled') FOR SHARE`,[resultSource.operation_id,identity.spaceId,projectId,threadId,resultSource.attempt,resultSource.execution_id]);
       if(bound.rowCount!==1)throw new HttpError(409,"Research result attempt changed before assessment");
       await db.query(`UPDATE inquiry_thread_steps SET target_ref_kind='research_operation',target_ref_id=$2 WHERE id=$1`,[stepId,resultSource.operation_id]);
      }
      await refreshProblem(db, identity.spaceId, threadId);
      await recordThreadWorkEvent(db, {
        spaceId: identity.spaceId,
        projectId,
        threadId,
        userId: identity.userId,
        eventKind: "thread.work_recorded",
        occurredAt: new Date().toISOString(),
        idempotencySuffix: stepId,
        data: {
          statement: thread.statement,
          step_id: stepId,
          ...(resultSource?{research_result:resultSource}:{}),
          summary: input.reason,
          method_version: input.method_version,
          reference_refs: [...input.input_refs, ...input.output_refs]
        },
        provenance
      });
      const result = await new InquiryProblemEngineService(db).projection(identity, projectId, threadId);
      await saveProblemCommand(db, identity, projectId, threadId, key, request, result);
      return result;
    });
  }
  async closeRound(identity: SpaceUserIdentity, projectId: string, threadId: string, body: unknown, provenance?: ThreadEventProvenance): Promise<Record<string, unknown>> {
    const input = parse(ProblemCloseRoundRequestSchema, body);
    return withQueryableTransaction(this.db, async db => {
      const thread = await lockProblem(db, identity, projectId, threadId),
        request = {
          command: "close_round",
          ...input
        };
      await assertProblemReferences(db, identity, projectId, input.input_refs);
      const key = problemCommandKey(identity, input.idempotency_key, provenance);
      const replay = await replayProblemCommand(db, identity.spaceId, threadId, key, request);
      if (replay) return {
        ...replay,
        projection: await new InquiryProblemEngineService(db).projection(identity, projectId, threadId)
      };
      checkProblemVersion(thread, input);
      if (input.start_next_primary && thread.blocked_reason) throw new HttpError(409, "Unblock the Thread before starting work");
      const closeout = await closeRoundFact(db, identity, projectId, thread, {
        ...input,
        input_refs: input.input_refs
      }, provenance);
      const result = {
        ...closeout,
        projection: await new InquiryProblemEngineService(db).projection(identity, projectId, threadId)
      };
      await saveProblemCommand(db, identity, projectId, threadId, key, request, result);
      return result;
    });
  }
}
