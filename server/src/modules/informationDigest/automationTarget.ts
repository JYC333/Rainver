import { getDbPool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import { PgAutomationRepository } from "../automations/repository";
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
import { HttpError } from "../routeUtils/common";
import { canonicalRunOutput } from "../runs/orchestrationResults";
import { PgRunRepository } from "../runs/repository";
import { InformationDigestService } from "./service";
import { BraveSerendipityProbeProvider, SerendipityProbeService } from "./serendipityProbe";

const TARGET_TYPE = "information_digest";

async function preflight(context: AutomationTargetPreflightContext): Promise<Record<string, unknown>> {
  const { input, repo } = context;
  const request = requestFromConfig(input.configJson, input.projectId);
  const errors: string[] = [];
  const membershipRole = await repo.getMembershipRole(input.spaceId, input.actorUserId);
  if (!membershipRole) errors.push("Information Digest automation requires active Space membership");
  if (request.scope === "project") {
    if (request.operation === "probe") errors.push("Serendipity probes are personal-only");
    if (!input.projectId || request.project_id !== input.projectId) {
      errors.push("Project digest scope must match the Automation project binding");
    }
    if (!request.project_id || !(await repo.projectInSpace(input.spaceId, request.project_id))) {
      errors.push("Project digest automation requires an active Project in this Space");
    } else if (!(await repo.canWriteProject(input.spaceId, request.project_id, input.actorUserId))) {
      errors.push("Project digest automation requires Project writer authority");
    }
  } else if (input.projectId) errors.push("Personal digest scope cannot carry a Project binding");
  const agent = await repo.getAgentPreflight(input.spaceId, input.agentId);
  if (!agent || agent.status !== "active" || !agent.current_version_id || !agent.version_id) {
    errors.push("Information Digest automation requires an active attribution Agent with a current version");
  }
  const snapshot = {
    executable: errors.length === 0,
    target_type: TARGET_TYPE,
    information_digest_preflight: {
      executable: errors.length === 0,
      scope: request.scope,
      operation: request.operation,
      project_id: request.project_id,
      attribution_agent_id: input.agentId,
      deterministic_ranking: true,
      errors,
    },
  };
  if (errors.length) throw new HttpError(errors.some((error) => error.includes("authority") || error.includes("membership")) ? 403 : 422, errors.join("; "));
  return snapshot;
}

async function execute(context: AutomationTargetExecutionContext): Promise<Record<string, unknown>> {
  const { config, automation, fireInput, triggerType, preflightSnapshot } = context;
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  const pool = getDbPool(config.databaseUrl);
  const request = requestFromConfig(automation.config_json, automation.project_id);
  const date = dateFromContext(fireInput.triggerContext);
  const started = await withTransaction(pool, async (client) => {
    await lockAndCheckAutomationBudget(client, automation);
    const run = await new PgRunRepository(client).createRunningSystemRun({
      space_id: fireInput.spaceId,
      user_id: fireInput.actorUserId,
      agent_id: automation.agent_id,
      project_folder_id: automation.project_folder_id,
      trigger_origin: "automation",
      prompt: request.operation === "probe"
        ? "Run the bounded weekly serendipity discovery probe."
        : `Build ${request.scope} information digest for ${date}.`,
      instruction: request.operation === "probe"
        ? "Fill the private standby pool from outside subscriptions without changing the interest profile."
        : "Rank already-annotated material deterministically and persist inspectable slot attribution.",
      capability_id: "library.information_digest",
      capabilities_json: ["library.information_digest"],
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
    const probe = request.operation === "probe"
      ? await new SerendipityProbeService(
          pool,
          new BraveSerendipityProbeProvider(pool, config),
        ).run(fireInput.spaceId, automation.owner_user_id)
      : null;
    const digest = request.operation === "daily"
      ? request.scope === "personal"
        ? await new InformationDigestService(pool).personal(fireInput.spaceId, automation.owner_user_id, date, started.runId)
        : await new InformationDigestService(pool).project(fireInput.spaceId, request.project_id!, fireInput.actorUserId, date, started.runId)
      : null;
    const outputText = probe
      ? `Serendipity probe ${probe.status} with ${probe.external_result_count + probe.source_recommendation_count} candidate(s).`
      : `Information digest completed with ${digest!.items.length} item(s).`;
    await withTransaction(pool, async (client) => {
      await new PgRunRepository(client).markRunTerminal({
        run_id: started.runId,
        space_id: fireInput.spaceId,
        status: probe?.status === "degraded" ? "degraded" : "succeeded",
        output_text: outputText,
        output_json: canonicalRunOutput({
          success: true,
          outputText,
          outputJson: probe
            ? { automation_target: TARGET_TYPE, operation: "probe", serendipity_probe: probe }
            : { automation_target: TARGET_TYPE, operation: "daily", digest_id: digest!.id, digest_date: date, item_count: digest!.items.length },
        }),
        exit_code: 0,
        completed_at: new Date().toISOString(),
      });
      if (context.advanceSchedule) await new PgAutomationRepository(client).advanceSchedule(automation);
    });
    return {
      run_id: started.runId,
      automation_run_id: started.automationRunId,
      target_type: TARGET_TYPE,
      operation: request.operation,
      ...(probe ? { serendipity_probe: probe } : {
        digest_id: digest!.id,
        digest_date: date,
        item_count: digest!.items.length,
      }),
    };
  } catch (error) {
    await withTransaction(pool, async (client) => {
      await new PgRunRepository(client).markRunTerminal({
        run_id: started.runId,
        space_id: fireInput.spaceId,
        status: "failed",
        output_text: "Information digest operation failed.",
        output_json: canonicalRunOutput({ success: false, outputText: "Information digest operation failed.", outputJson: { automation_target: TARGET_TYPE, operation: request.operation } }),
        error_json: { error_code: "information_digest_automation_failed", error_text: error instanceof Error ? error.message : "Digest generation failed" },
        exit_code: 1,
        completed_at: new Date().toISOString(),
      });
      if (context.advanceSchedule) await new PgAutomationRepository(client).advanceSchedule(automation);
    });
    if (context.advanceSchedule) throw markAutomationScheduleHandled(error, "Information digest operation failed");
    throw error;
  }
}

export function registerInformationDigestAutomationTarget(): void {
  automationTargetHandlerRegistry.register(TARGET_TYPE, { preflight, execute });
}

function requestFromConfig(configJson: Record<string, unknown> | null | undefined, boundProjectId?: string | null) {
  const config = recordValue(configJson);
  const scope = config.scope === "project" ? "project" as const : "personal" as const;
  const projectId = typeof config.project_id === "string" ? config.project_id : boundProjectId ?? null;
  const operation = config.operation === "probe" ? "probe" as const : "daily" as const;
  return { scope, operation, project_id: scope === "project" ? projectId : null };
}

function dateFromContext(context: Record<string, unknown> | null | undefined): string {
  const value = recordValue(context).digest_date;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date().toISOString().slice(0, 10);
}
