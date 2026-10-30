import {submitMaterialResults} from './materialProcessing/submission.js';
import {SourceProviderCatalogService} from './catalog/sourceProviderCatalogService.js';
import {CustomSourceCredentialService} from './customSources/customSourceCredentialService.js';
import {requireGoal} from './goals/access.js';
import {HttpError} from '../routeUtils/common.js';
import {registerSourceGoalActions} from './goals/actions.js';
import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { SourceChannelService } from "./channels/sourceChannelService.js";
import { SourceBackfillPlanningService } from "./sourceBackfillService.js";

/**
 * `source.channel.propose_activation` and `source.backfill.propose_start`.
 * Both draft a reviewable Proposal; durable mutation happens only through the owning applier after
 * acceptance.
 */
export function registerSourcesSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  registerSourceGoalActions(executors,config,run);
  executors.set('source.material.submit',async input=>({modelResult:{ok:true,result:await submitMaterialResults(config,run,input)},summary:{tool_name:'source.material.submit',ok:true}}));
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("source.channel.propose_activation" as SystemActionId, async (input, context) => {
    const goal=(run.contract_snapshot_json as {workflow_input_json?:{source_goal?:{purpose?:string;goal_id?:string}}})?.workflow_input_json?.source_goal;
    const body=input as Record<string,unknown>;
    let credentialed=false;
    if(goal?.goal_id){const provider=await new SourceProviderCatalogService(db).resolve(String(body.provider_key));credentialed=provider.connector_key==='brave_web_search_api'||(provider.provider_capabilities_json as {requires_credential?:boolean})?.requires_credential===true||(provider.mapping_capabilities_json as {requires_credential?:boolean})?.requires_credential===true;
     if(credentialed){const g=await requireGoal(db,identity,goal.goal_id,true);if(g.compatibility_json?.search_path!=='api'||typeof body.credential_id!=='string')throw new HttpError(409,'source_credential_decision_required',{error:'source_credential_decision_required',message:'Ask whether the person has a search API credential and wants this source; do not send secrets in chat.'});await new CustomSourceCredentialService(db,config).requireOwnCredential(identity,body.credential_id);}}

    const result = await new SourceChannelService(db, config).proposeActivation(identity, {...input as Record<string, unknown>,project_id:run.project_id}, {
      forceReview:credentialed,
      agentId: run.agent_id,
      runId: run.id,
      idempotencyKey: context.idempotency_key,
      projectId: run.project_id,
    });
    return {
      modelResult: { ok: true, proposal: result.proposal, channel: result.channel, auto_applied: result.auto_applied, next_step: result.auto_applied ? "Read source.goal.sources again and use only its authorized IDs." : "Await approval. This draft is not an authorized Source; do not write a plan with its IDs." },
      summary: { tool_name: "source.channel.propose_activation", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
    };
  });

  executors.set("source.backfill.propose_start" as SystemActionId, async (input, context) => {
    const body = input as Record<string, unknown>;
    const channelId = String(body.source_channel_id ?? "");
    const planId = String(body.source_backfill_plan_id ?? "");
    const result = await new SourceBackfillPlanningService(db, config).proposeStart(identity, channelId, planId, {
      agentId: run.agent_id,
      runId: run.id,
      idempotencyKey: context.idempotency_key,
      projectId: run.project_id,
    });
    return {
      modelResult: { ok: true, proposal: result.proposal },
      summary: { tool_name: "source.backfill.propose_start", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
    };
  });
}
