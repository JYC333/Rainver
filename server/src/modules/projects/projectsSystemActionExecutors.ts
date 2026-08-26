import type { SystemActionId } from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { runVisibility } from "../runs/runInputEnvelope.js";
import { ProjectSourceProposalService } from "./projectSourceProposalService.js";
import { ProjectDefinitionProposalService } from "./projectDefinitionProposalService.js";

/**
 * `project.source.propose_bind` and `project.propose_definition` (action
 * authority consolidation plan, P1.5). Both draft a reviewable Proposal;
 * durable mutation happens only through the owning applier after
 * acceptance.
 */
export function registerProjectsSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("project.source.propose_bind" as SystemActionId, async (input, context) => {
    if (!run.project_id) throw new Error("project.source.propose_bind requires a project-scoped run");
    const result = await new ProjectSourceProposalService(db, config).proposeBind(identity, run.project_id, input as Record<string, unknown>, {
      agentId: run.agent_id,
      runId: run.id,
      idempotencyKey: context.idempotency_key,
    });
    return {
      modelResult: { ok: true, proposal: result.proposal },
      summary: { tool_name: "project.source.propose_bind", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
    };
  });

  executors.set("project.propose_definition" as SystemActionId, async (input, context) => {
    if (!run.project_id) throw new Error("project.propose_definition requires a project-scoped run");
    const result = await new ProjectDefinitionProposalService(db).proposeDefinition(
      identity,
      run.project_id,
      input as Record<string, unknown>,
      {
        agentId: run.agent_id,
        runId: run.id,
        idempotencyKey: context.idempotency_key,
        visibility: runVisibility(run.visibility),
      },
    );
    return {
      modelResult: { ok: true, proposal: result.proposal },
      summary: { tool_name: "project.propose_definition", ok: true, proposal_id: (result.proposal as { id?: string }).id },
    };
  });
}
