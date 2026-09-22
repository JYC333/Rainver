import { getDbPool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { PgAutomationRepository } from "../automations/repository.js";
import {
  automationTargetHandlerRegistry,
  type AutomationTargetExecutionContext,
  type AutomationTargetPreflightContext,
} from "../automations/targetRegistry.js";
import {
  lockAndCheckAutomationBudget,
  markAutomationScheduleHandled,
  recordValue,
} from "../automations/targetSupport.js";
import { HttpError } from "../routeUtils/common.js";
import { InformationDigestService } from "./service.js";
import { BraveSerendipityProbeProvider, SerendipityProbeService } from "./serendipityProbe.js";

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
    const automationRunId = await new PgAutomationRepository(client).createAutomationRun({
      automationId: automation.id,
      targetType: TARGET_TYPE,
      runId: null,
      triggeredByUserId: fireInput.actorUserId,
      triggerType,
      preflightSnapshot,
    });
    return { automationRunId };
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
        ? await new InformationDigestService(pool).personal(fireInput.spaceId, automation.owner_user_id, date, started.automationRunId)
        : await new InformationDigestService(pool).project(fireInput.spaceId, request.project_id!, fireInput.actorUserId, date, started.automationRunId)
      : null;
    await withTransaction(pool, async (client) => {
      await new PgAutomationRepository(client).completeNativeAutomationRun({
        automationRunId: started.automationRunId,
        status: probe?.status === "degraded" ? "degraded" : "succeeded",
        result: probe
          ? {
              operation: "probe",
              status: probe.status,
              external_result_count: probe.external_result_count,
              source_recommendation_count: probe.source_recommendation_count,
            }
          : { operation: "daily", digest_id: digest!.id, digest_date: date, item_count: digest!.items.length },
      });
      if (context.advanceSchedule) await new PgAutomationRepository(client).advanceSchedule(automation);
    });
    return {
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
      await new PgAutomationRepository(client).completeNativeAutomationRun({
        automationRunId: started.automationRunId,
        status: "failed",
        error: {
          error_code: "information_digest_automation_failed",
          error_text: error instanceof Error ? error.message : "Digest generation failed",
        },
      });
      if (context.advanceSchedule) await new PgAutomationRepository(client).advanceSchedule(automation);
    });
    if (context.advanceSchedule) throw markAutomationScheduleHandled(error, "Information digest operation failed");
    throw error;
  }
}

export function registerInformationDigestAutomationTarget(): void {
  automationTargetHandlerRegistry.register(TARGET_TYPE, { preflight, execute }, "informationDigest");
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
