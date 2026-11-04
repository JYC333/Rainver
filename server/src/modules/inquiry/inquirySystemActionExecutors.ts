import { InquiryTaskAssociationService } from "./taskAssociations.js";
import { problemThreadPage } from "./problemReadModel.js";
import { InquiryProblemEngineService } from "./problemEngineService.js";
import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import { PgRunRepository, type RunRecord } from "../runs/repository.js";
import { HttpError, withQueryableTransaction } from "../routeUtils/common.js";
import { lockActiveProjectForMutation } from "../projects/access.js";
import { InquiryThreadService } from "./threadService.js";
import { InquiryIterationService } from "./iterationService.js";
import {
  THREAD_FAN_OUT_PER_TURN,
  countThreadsOpenedInTurn,
  findActiveThreadWithStatement,
  threadCallIdempotencyKey,
} from "./threadFanOut.js";

/**
 * Inquiry's Agent tool surface.
 *
 * `inquiry.create_thread` and `inquiry.record_conclusion` write directly
 * ([ADR 0017](../../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md)
 * §2). A person asking in the turn is the authorization. The gates are the
 * trigger origin, the per-turn fan-out bound, and the Project's updates,
 * where every write here can be undone. Do not put a proposal gate on these
 * two.
 * `inquiry.promote_knowledge` is still a proposal — promoting leaves the
 * Project for Space-level Knowledge, which is a change in reach.
 */
export function registerInquirySystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  const taskAssociations=new InquiryTaskAssociationService(db);
  for(const action of ["inquiry.link_task","inquiry.list_tasks","inquiry.reference_task_result"] as const){
    executors.set(action as SystemActionId,async(input,dispatch)=>{
      if(!run.project_id)throw new HttpError(422,"A Project Run is required");
      const {thread_id,task_id,after_task_id,...body}=input as Record<string,unknown>;
      const provenance={runId:run.id,agentId:run.agent_id};
      if(action==="inquiry.list_tasks"){
        const page=await taskAssociations.tasks(identity,run.project_id,String(thread_id),after_task_id as string|undefined);
        return {modelResult:{ok:true,...page},summary:{tool_name:action,ok:true}};
      }
      if(!dispatch.idempotency_key)throw new HttpError(422,"A canonical call identity is required");
      // The call id is a per-process counter that restarts on a Supervisor retry
      // of the same Run, so the receipt identity includes the attempt.
      const attempt=(await new PgRunRepository(db).getLatestRunAttempt(run.space_id,run.id))?.attempt_number??1;
      const trustedCall=`${attempt}:${dispatch.idempotency_key}`;
      const result=action==='inquiry.link_task'?await taskAssociations.link(identity,run.project_id,String(thread_id),{...body,...(task_id?{task_id}:{}),idempotency_key:dispatch.idempotency_key},provenance,trustedCall)
        :await taskAssociations.referenceResult(identity,run.project_id,String(thread_id),String(task_id),{...body,idempotency_key:dispatch.idempotency_key},provenance,trustedCall);
      return {modelResult:{ok:true,...result},summary:{tool_name:action,ok:true}};
    });
  }
  executors.set("inquiry.list_threads" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("inquiry.list_threads requires a project-scoped run");
    const page=await problemThreadPage(db,identity,run.project_id,input as {kind?:string;limit?:number;after_thread_id?:string});
    return {modelResult:{ok:true,tool:"inquiry.list_threads",...page},summary:{tool_name:"inquiry.list_threads",ok:true,count:page.threads.length}};
  });
  executors.set("inquiry.read_problem",async input=>{
    if(!run.project_id)throw new Error("inquiry.read_problem requires a Project");
    const {thread_id,...options}=input as {thread_id:string;limit?:number;before_step?:number;before_closeout?:number};
    return {modelResult:{ok:true,tool:"inquiry.read_problem",...(await new InquiryProblemEngineService(db).projection(identity,run.project_id,thread_id,options))},summary:{tool_name:"inquiry.read_problem",ok:true}};
  });

  executors.set("inquiry.create_thread" as SystemActionId, async (input, context) => {
    if (!run.project_id) throw new Error("inquiry.create_thread requires a project-scoped run");
    const projectId = run.project_id;
    const provenance = { runId: run.id, agentId: run.agent_id };
    // One transaction for the count and the write. Do not read then write on
    // the pool. Two tool calls in one turn would both see four and both
    // create — six questions past a bound of five. `createThread` takes
    // `lockActiveProjectForMutation` inside, and
    // that lock serialises the whole class, so counting under it is enough.
    const thread = await withQueryableTransaction(db, async (tx) => {
      await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
      const opened = await countThreadsOpenedInTurn(tx, identity.spaceId, projectId, provenance);
      if (opened >= THREAD_FAN_OUT_PER_TURN) {
        throw new HttpError(
          429,
          `This turn already opened ${THREAD_FAN_OUT_PER_TURN} questions. Continue in the next turn, or tell the user what is left to open.`,
        );
      }
      // The same question arrives twice in two ways: the same tool call
      // delivered again (the key), and a re-planned turn producing the same
      // statement under a fresh call id (the statement). A duplicate Thread
      // is durable — the person has to archive it — so both are coalesced
      // here. Do not leave the duplicate to be cleaned up.
      const body = input as Record<string, unknown>;
      const statement = typeof body.statement === "string" ? body.statement : "";
      const existing = statement
        ? await findActiveThreadWithStatement(tx, identity.spaceId, projectId, statement)
        : null;
      if (existing) {
        const rows = await new InquiryThreadService(tx).listThreads(identity, projectId);
        const found = rows.find((row) => String(row.id) === existing);
        if (found) return found;
      }
      return new InquiryThreadService(tx).createThread(
        identity,
        projectId,
        {
          ...body,
          producer_idempotency_key: threadCallIdempotencyKey(run.id, context.idempotency_key),
        },
        provenance,
      );
    });
    return {
      modelResult: { ok: true, tool: "inquiry.create_thread", thread_id: thread.id, statement: thread.statement },
      summary: { tool_name: "inquiry.create_thread", ok: true, thread_id: thread.id },
    };
  });

  for(const [action,method] of [["inquiry.record_work","recordWork"],["inquiry.close_round","closeRound"]] as const) {
    executors.set(action,async input=>{
      if(!run.project_id)throw new Error(`${action} requires a Project`);
      const {thread_id,...body}=input as Record<string,unknown>;
      const result=await new InquiryProblemEngineService(db)[method](identity,run.project_id,String(thread_id),body,{runId:run.id,agentId:run.agent_id});
      return {modelResult:{ok:true,tool:action,...result},summary:{tool_name:action,ok:true,thread_id}};
    });
  }
  executors.set("inquiry.record_conclusion" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("inquiry.record_conclusion requires a project-scoped run");
    const body = input as { thread_id: string } & Record<string, unknown>;
    const cognitiveKeys=["answer_state","current_answer_summary","known_gaps","answerability","evaluation_state","confidence","confidence_method"];
    if(body.method_version==="problem_solving.v1" && body.round_intent==="close_round" && !cognitiveKeys.some(key=>Object.hasOwn(body,key))) {
      const result=await new InquiryProblemEngineService(db).closeRound(identity,run.project_id,String(body.thread_id),{
        method_version:body.method_version,expected_version:body.expected_version,expected_revision:body.expected_revision,idempotency_key:body.idempotency_key,
        summary:body.change_summary,input_refs:body.input_refs??[],...(body.start_next_primary?{start_next_primary:body.start_next_primary}:{}),
      },{runId:run.id,agentId:run.agent_id});
      return {modelResult:{ok:true,tool:"inquiry.record_conclusion",...result},summary:{tool_name:"inquiry.record_conclusion",ok:true,thread_id:body.thread_id}};
    }
    const result = await new InquiryIterationService(db).recordIteration(
      identity,
      run.project_id,
      String(body.thread_id),
      { ...body, trigger_kind: "agent_conclusion", trigger_ref: run.id },
      { runId: run.id, agentId: run.agent_id },
    );
    return {
      modelResult: { ok: true, tool: "inquiry.record_conclusion", thread_id: body.thread_id, iteration_id: (result as { id?: string }).id },
      summary: { tool_name: "inquiry.record_conclusion", ok: true, thread_id: body.thread_id },
    };
  });
}

interface ActiveThreadRef {
  thread_id: string;
  kind: string;
  statement: string;
  attention_state: string | null;

}

/** The active Threads of a Project as an Agent may address them: id first. */
export async function listActiveThreadRefs(
  threads: InquiryThreadService,
  identity: { spaceId: string; userId: string },
  projectId: string,
  kind?: "question" | "hypothesis",
): Promise<ActiveThreadRef[]> {
  const rows=await threads.listProblemThreadPage(identity,projectId,{kind});
  return rows.threads as ActiveThreadRef[];
}
