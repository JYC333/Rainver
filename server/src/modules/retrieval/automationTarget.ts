import { getDbPool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import {
  automationTargetHandlerRegistry,
  type AutomationTargetExecutionContext,
  type AutomationTargetPreflightContext,
} from "../automations/targetRegistry";
import {
  automationContract,
  lockAndCheckAutomationBudget,
  markAutomationScheduleHandled,
  recordValue,
} from "../automations/targetSupport";
import { knowledgeRetrievalRegistry } from "../knowledge/retrievalAdapter";
import { HttpError } from "../routeUtils/common";
import { canonicalRunOutput } from "../runs/orchestrationResults";
import { PgRunRepository } from "../runs/repository";
import { PgAutomationRepository } from "../automations/repository";
import {
  createRetrievalMaintenanceProposalPacket,
  persistRetrievalMaintenanceReportArtifact,
} from "./maintenance/artifacts";
import { RetrievalMaintenanceService } from "./maintenance/service";
import { readSpaceRetrievalSettings } from "./settings";

const TARGET_TYPE = "knowledge_retrieval_maintenance";

async function preflight(
  context: AutomationTargetPreflightContext,
): Promise<Record<string, unknown>> {
  const { input, repo, config } = context;
  const membershipRole = await repo.getMembershipRole(input.spaceId, input.actorUserId);
  const errors: string[] = [];
  let hasPermissionError = false;
  if (membershipRole !== "owner" && membershipRole !== "admin") {
    hasPermissionError = true;
    errors.push("Knowledge retrieval maintenance automation requires space owner or admin authority");
  }
  const agent = await repo.getAgentPreflight(input.spaceId, input.agentId);
  if (!agent) {
    errors.push("Knowledge retrieval maintenance automation requires an existing attribution Agent");
  } else {
    if (agent.status !== "active") {
      errors.push(`Knowledge retrieval maintenance attribution Agent is not active (status=${agent.status})`);
    }
    if (!agent.current_version_id) {
      errors.push("Knowledge retrieval maintenance attribution Agent has no current version");
    } else if (!agent.version_id) {
      errors.push("Knowledge retrieval maintenance attribution Agent current version was not found");
    }
  }
  const snapshot = {
    executable: errors.length === 0,
    target_type: TARGET_TYPE,
    maintenance_preflight: {
      executable: errors.length === 0,
      scope: "knowledge",
      attribution_agent_id: input.agentId,
      attribution_agent_status: agent?.status ?? null,
      attribution_agent_version_id: agent?.current_version_id ?? null,
      persist_report: true,
      create_packet: shouldCreatePacket(input.configJson),
      membership_role: membershipRole ?? "guest",
      errors,
      warnings: config.databaseUrl ? [] : ["SERVER_DATABASE_URL is not configured"],
    },
  };
  if (errors.length) {
    throw new HttpError(hasPermissionError ? 403 : 422, errors.join("; "));
  }
  return snapshot;
}

async function execute(
  context: AutomationTargetExecutionContext,
): Promise<Record<string, unknown>> {
  const { config, automation, fireInput, triggerType, preflightSnapshot } = context;
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  const pool = getDbPool(config.databaseUrl);
  const started = await withTransaction(pool, async (client) => {
    const runs = new PgRunRepository(client);
    await lockAndCheckAutomationBudget(client, automation);
    const run = await runs.createRunningSystemRun({
      space_id: fireInput.spaceId,
      user_id: fireInput.actorUserId,
      agent_id: automation.agent_id,
      project_folder_id: automation.project_folder_id,
      trigger_origin: "automation",
      prompt: "Run Knowledge retrieval maintenance scan.",
      instruction: "Persist an owner-private maintenance report and optionally create a review packet.",
      capability_id: "knowledge.retrieval.maintenance",
      capabilities_json: ["knowledge.retrieval.maintenance"],
      source: triggerType === "schedule" ? "scheduled" : "managed",
      contract_snapshot: automationContract(automation),
    });
    const automationRunId = await new PgAutomationRepository(client).createAutomationRun({
      automationId: automation.id,
      runId: run.id,
      triggeredByUserId: fireInput.actorUserId,
      triggerType,
      preflightSnapshot,
    });
    return { runId: run.id, automationRunId };
  });

  try {
    const report = await new RetrievalMaintenanceService(
      pool,
      knowledgeRetrievalRegistry,
    ).scan(fireInput.spaceId, fireInput.actorUserId);
    const settings = await readSpaceRetrievalSettings(pool, fireInput.spaceId);
    const persisted = await withTransaction(pool, async (client) => {
      const reportContext = {
        spaceId: fireInput.spaceId,
        ownerUserId: fireInput.actorUserId,
        runId: started.runId,
        report,
        source: "automation_knowledge_retrieval_maintenance",
        settingsSnapshot: {
          default_search_mode: settings.defaultSearchMode,
          rerank_enabled: settings.rerankEnabled,
          query_rewrite_enabled: settings.queryRewriteEnabled,
          use_query_cache: settings.useQueryCache,
          include_trace: settings.includeTrace,
          external_egress_enabled: settings.externalEgressEnabled,
          retrieval_tool_mode: settings.retrievalToolMode,
          embedding_dimensions: settings.embeddingDimensions,
          max_results_default: settings.maxResultsDefault,
        },
      };
      const artifactId = await persistRetrievalMaintenanceReportArtifact(client, reportContext);
      const proposalId = shouldCreatePacket(automation.config_json)
        ? await createRetrievalMaintenanceProposalPacket(client, {
            ...reportContext,
            artifactId,
          })
        : undefined;
      await new PgRunRepository(client).markRunTerminal({
        run_id: started.runId,
        space_id: fireInput.spaceId,
        status: "succeeded",
        output_text: `Knowledge retrieval maintenance scan completed with ${report.findings.length} finding(s).`,
        output_json: canonicalRunOutput({
          success: true,
          outputText: `Knowledge retrieval maintenance scan completed with ${report.findings.length} finding(s).`,
          outputJson: {
            automation_target: TARGET_TYPE,
            retrieval_maintenance_report: {
              artifact_id: artifactId,
              proposal_id: proposalId ?? null,
              finding_count: report.findings.length,
              scanned: report.scanned,
              counts: report.counts,
              truncated: report.truncated,
            },
          },
        }),
        exit_code: 0,
        completed_at: new Date().toISOString(),
      });
      if (context.advanceSchedule) {
        await new PgAutomationRepository(client).advanceSchedule(automation);
      }
      return { artifactId, proposalId };
    });
    return {
      run_id: started.runId,
      automation_run_id: started.automationRunId,
      trigger_origin: "automation",
      preflight_executable: Boolean(preflightSnapshot.executable),
      target_type: TARGET_TYPE,
      artifact_id: persisted.artifactId,
      proposal_id: persisted.proposalId ?? null,
      finding_count: report.findings.length,
      scanned: report.scanned,
      truncated: report.truncated,
    };
  } catch (error) {
    await withTransaction(pool, async (client) => {
      await new PgRunRepository(client).markRunTerminal({
        run_id: started.runId,
        space_id: fireInput.spaceId,
        status: "failed",
        output_text: "Knowledge retrieval maintenance scan failed.",
        output_json: canonicalRunOutput({
          success: false,
          outputText: "Knowledge retrieval maintenance scan failed.",
          outputJson: { automation_target: TARGET_TYPE },
        }),
        error_json: {
          error_code: "retrieval_maintenance_automation_failed",
          error_text: error instanceof Error ? error.message : "Maintenance scan failed",
        },
        exit_code: 1,
        completed_at: new Date().toISOString(),
      });
      if (context.advanceSchedule) {
        await new PgAutomationRepository(client).advanceSchedule(automation);
      }
    });
    if (context.advanceSchedule) throw markAutomationScheduleHandled(error, "Maintenance scan failed");
    throw error;
  }
}

export function registerRetrievalMaintenanceAutomationTarget(): void {
  automationTargetHandlerRegistry.register(TARGET_TYPE, { preflight, execute });
}

function shouldCreatePacket(configJson: Record<string, unknown> | null | undefined): boolean {
  return recordValue(configJson).create_packet === true;
}
