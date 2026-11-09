import { InquiryTaskAssociationService } from "./taskAssociations.js";
import { problemThreadPage } from "./problemReadModel.js";
import { InquiryProblemEngineService } from "./problemEngineService.js";
import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import { type RunRecord } from "../runs/repository.js";
import { HttpError, withQueryableTransaction } from "../routeUtils/common.js";
import { lockActiveProjectForMutation } from "../projects/access.js";
import { InquiryThreadService } from "./threadService.js";
import {
  THREAD_FAN_OUT_PER_TURN,
  countThreadsOpenedInTurn,
  findActiveThreadWithStatement,
  threadCallIdempotencyKey,
} from "./threadFanOut.js";

/**
 * Inquiry's Agent tool surface.
 *
 * `inquiry.create_thread` writes directly
 * ([ADR 0017](../../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md)
 * §2). A person asking in the turn is the authorization. The gates are the
 * trigger origin, the per-turn fan-out bound, and the Project's updates,
 * where every write here can be undone. Do not put a proposal gate on these
 * entry.
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
  executors.set("inquiry.list_tasks",async input=>{
    if(!run.project_id)throw new HttpError(422,"A Project Run is required");
    const {thread_id,after_task_id}=input as {thread_id:string;after_task_id?:string};
    const page=await taskAssociations.tasks(identity,run.project_id,thread_id,after_task_id);
    return {modelResult:{ok:true,...page},summary:{tool_name:"inquiry.list_tasks",ok:true}};
  });
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
