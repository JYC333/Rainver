import { assertResearchResultRunEgress } from "./researchResultEgress.js";
import {listResearchOperationRefs} from "./researchOperationDiscovery.js";
import { ResearchProblemResultService } from "./researchProblemResults.js";
import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";

/** Read-only Agent Research tools. `research.start_acquisition` and
 * `research.adopt_result` are core-owned operations (`agentResearchOperations.ts`). */
export function registerProjectResearchSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("research.read_result",async input=>{
    if(!run.project_id)throw new Error("Research result requires Project context");
    const result=await new ResearchProblemResultService(db).read(identity,run.project_id,String((input as {operation_id:string}).operation_id));
    await assertResearchResultRunEgress(db,run,String((input as {operation_id:string}).operation_id));
    return {modelResult:{ok:true,tool:"research.read_result",...result},summary:{tool_name:"research.read_result",ok:true}};
  });
  executors.set("research.list_operations" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("research.list_operations requires a project-scoped run");
    const operations = await listResearchOperationRefs(db,identity,run.project_id,(input as { include_terminal?: boolean }).include_terminal === true);
    return {
      modelResult: { ok: true, tool: "research.list_operations", operations },
      summary: { tool_name: "research.list_operations", ok: true, count: operations.length },
    };
  });


}
