import { assertResearchResultRunEgress } from "./researchResultEgress.js";
import { assertResearchCallReadable } from "./researchCallAccess.js";
import { ResearchProblemResultService } from "./researchProblemResults.js";
import { problemCommandKey } from "../inquiry/problemFacts.js";
import type { SystemActionId } from "@rainver/protocol";
import { HttpError } from "../routeUtils/common.js";
import { InquiryThreadService } from "../inquiry/threadService.js";
import { listActiveThreadRefs } from "../inquiry/inquirySystemActionExecutors.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { PgAgentGroupRepository } from "../agentGroups/repository.js";
import { ResearchAcquisitionService } from "./pipeline/researchAcquisitionService.js";
import { ResearchOperationCancelService } from "./researchOperationCancel.js";
import { assertProjectReadable } from "../projects/access.js";

/**
 * `research.start_acquisition`: unlike a generic
 * proposal executor, this is direct-execution, so the executor calls
 * `ResearchAcquisitionService` rather than a proposal service. Room origin
 * is resolved from the Run's own agent-group membership — the same lookup
 * `AgentGroupRunLifecycleProjector` uses for delegation-completion
 * notifications — not carried by the tool call itself, matching how
 * `agent.delegate` never asks the model for room context either.
 */
export function registerProjectResearchSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("research.start_acquisition" as SystemActionId, async (input,context) => {
    if (!run.project_id) throw new Error("research.start_acquisition requires a project-scoped run");
    if(!context.idempotency_key)throw new HttpError(422,"research.start_acquisition requires its canonical action-call id");
    const body = input as { thread_id: string; intent_note?: string; max_items?: number; since?: string };
    const origin = run.run_group_id ? await new PgAgentGroupRepository(db).getGroup(run.space_id, run.run_group_id) : null;
    const result = await new ResearchAcquisitionService(db).startAcquisition(identity, run.project_id, {
      requestKey:problemCommandKey(identity,context.idempotency_key,{runId:run.id}),
      originRunId:run.id,
      threadId: body.thread_id,
      intentNote: body.intent_note ?? null,
      originRoomId: origin?.room_id ?? null,
      originSessionId: origin?.session_id ?? null,
      originGroupId: origin?.room_id ? origin.id : null,
      maxItems: body.max_items ?? null,
      since: body.since ?? null,
    }).catch(async (error: unknown) => {
      // An unknown id is almost always an invented one. Answer with the ids
      // that do exist so the next call can copy one instead of guessing again.
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
      const active = await listActiveThreadRefs(new InquiryThreadService(db), identity, run.project_id!, "question");
      throw new HttpError(404, active.length === 0
        ? `No active Question Thread has id '${body.thread_id}', and this Project has no active Question Thread yet — open one with inquiry.create_thread, then start the acquisition on it.`
        : `No active Question Thread has id '${body.thread_id}'. Read inquiry.list_threads for the complete paginated list. First matching ids: ${active.map((thread) => `${thread.thread_id} — ${thread.statement}`).join("; ")}`);
    });
    return {
      modelResult: { ok: true, tool: "research.start_acquisition", ...result },
      summary: { tool_name: "research.start_acquisition", ok: true, ...result },
    };
  });

  executors.set("research.read_result",async input=>{
    if(!run.project_id)throw new Error("Research result requires Project context");
    const result=await new ResearchProblemResultService(db).read(identity,run.project_id,String((input as {operation_id:string}).operation_id));
    await assertResearchResultRunEgress(db,run,String((input as {operation_id:string}).operation_id));
    return {modelResult:{ok:true,tool:"research.read_result",...result},summary:{tool_name:"research.read_result",ok:true}};
  });
  executors.set("research.adopt_result",async input=>{
    if(!run.project_id)throw new Error("Research result requires Project context");
    const {operation_id,...body}=input as Record<string,unknown>;
    await new ResearchProblemResultService(db).read(identity,run.project_id,String(operation_id));
    await assertResearchResultRunEgress(db,run,String(operation_id));
    const result=await new ResearchProblemResultService(db).adopt(identity,run.project_id,String(operation_id),body,{runId:run.id,agentId:run.agent_id});
    return {modelResult:{ok:true,tool:"research.adopt_result",...result},summary:{tool_name:"research.adopt_result",ok:true}};
  });
  /** This Project's research Operations as an Agent may address them. */
  const listResearchOperations = async (includeTerminal: boolean): Promise<Array<{ operation_id: string; title: string; status: string }>> => {
    // As the instructing person would read it (`ProjectOperationService.list`):
    // a Run outlives a membership revoked mid-turn, this read does not.
    await assertProjectReadable(db, identity.spaceId, run.project_id!, identity.userId);
    const rows = await db.query<{ id: string; title: string | null; status: string;research_call_json:unknown }>(
      `SELECT id, title, status,research_call_json FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research'
          ${includeTerminal ? "" : "AND status NOT IN ('completed','cancelled','failed')"}
        ORDER BY updated_at DESC LIMIT 50`,
      [identity.spaceId, run.project_id],
    );
    const visible=[];
    for(const row of rows.rows){
     try{const call=await assertResearchCallReadable(db,identity,run.project_id!,row.research_call_json,undefined,"stop");visible.push({operation_id:row.id,title:call?"Research invocation":row.title??"Research operation",status:row.status,...(call?{thread_id:call.thread_id}:{})});}
     catch(error){if(!(error instanceof HttpError)||error.statusCode!==404)throw error;}
    }
    return visible;
  };

  executors.set("research.list_operations" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("research.list_operations requires a project-scoped run");
    const operations = await listResearchOperations((input as { include_terminal?: boolean }).include_terminal === true);
    return {
      modelResult: { ok: true, tool: "research.list_operations", operations },
      summary: { tool_name: "research.list_operations", ok: true, count: operations.length },
    };
  });

  executors.set("research.cancel_acquisition" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("research.cancel_acquisition requires a project-scoped run");
    const body = input as { operation_id: string; reason?: string };
    const result = await new ResearchOperationCancelService(db).cancelOperation(
      identity,
      run.project_id,
      body.operation_id,
      body.reason ?? null,
    ).catch(async (error: unknown) => {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
      const running = await listResearchOperations(false);
      throw new HttpError(404, running.length === 0
        ? `No research Operation has id '${body.operation_id}', and this Project has no research running.`
        : `No research Operation has id '${body.operation_id}'. Use one of these ids exactly: ${running.map((operation) => `${operation.operation_id} — ${operation.title} (${operation.status})`).join("; ")}`);
    });
    return {
      modelResult: { ok: true, tool: "research.cancel_acquisition", ...result },
      summary: { tool_name: "research.cancel_acquisition", ok: true, ...result },
    };
  });
}
