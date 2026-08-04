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
import { readSpaceRetrievalSettings } from "../retrieval/settings";
import { runContextReviewCycle } from "./reviewCycle";

const TARGET_TYPE = "context_ops_review_cycle";

async function preflight(
  context: AutomationTargetPreflightContext,
): Promise<Record<string, unknown>> {
  const { input, repo, config } = context;
  const request = requestFromConfig(input.configJson);
  const membershipRole = await repo.getMembershipRole(input.spaceId, input.actorUserId);
  const errors: string[] = [];
  let hasPermissionError = false;
  if (membershipRole !== "owner" && membershipRole !== "admin") {
    hasPermissionError = true;
    errors.push("Context Review Cycle automation requires space owner or admin authority");
  }
  if (request.review_scope === "space_ops" && config.databaseUrl) {
    const settings = await readSpaceRetrievalSettings(getDbPool(config.databaseUrl), input.spaceId);
    if (settings.contextOpsReviewMode === "private_only") {
      errors.push("Context Review Cycle space_ops review requires Context Ops review mode to allow admins");
    }
  }
  const agent = await repo.getAgentPreflight(input.spaceId, input.agentId);
  if (!agent) {
    errors.push("Context Review Cycle automation requires an existing attribution Agent");
  } else {
    if (agent.status !== "active") {
      errors.push(`Context Review Cycle attribution Agent is not active (status=${agent.status})`);
    }
    if (!agent.current_version_id) {
      errors.push("Context Review Cycle attribution Agent has no current version");
    } else if (!agent.version_id) {
      errors.push("Context Review Cycle attribution Agent current version was not found");
    }
  }
  const snapshot = {
    executable: errors.length === 0,
    target_type: TARGET_TYPE,
    context_review_cycle_preflight: {
      executable: errors.length === 0,
      scope: "context_ops",
      attribution_agent_id: input.agentId,
      attribution_agent_status: agent?.status ?? null,
      attribution_agent_version_id: agent?.current_version_id ?? null,
      persist_report: true,
      create_packets: request.create_packets,
      review_scope: request.review_scope,
      include_memory_maintenance: request.include_memory_maintenance,
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
    await lockAndCheckAutomationBudget(client, automation);
    const run = await new PgRunRepository(client).createRunningSystemRun({
      space_id: fireInput.spaceId,
      user_id: fireInput.actorUserId,
      agent_id: automation.agent_id,
      project_folder_id: automation.project_folder_id,
      trigger_origin: "automation",
      prompt: "Run Context Review Cycle.",
      instruction: "Persist aggregate Context Ops reports and review packets without direct canonical writes.",
      capability_id: "context_ops.review_cycle",
      capabilities_json: ["context_ops.review_cycle"],
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
    const result = await withTransaction(pool, async (client) => {
      const reviewResult = await runContextReviewCycle(client, {
        spaceId: fireInput.spaceId,
        userId: fireInput.actorUserId,
        request: requestFromConfig(automation.config_json),
        runId: started.runId,
      });
      await new PgRunRepository(client).markRunTerminal({
        run_id: started.runId,
        space_id: fireInput.spaceId,
        status: reviewResult.degraded ? "degraded" : "succeeded",
        output_text: reviewResult.degraded
          ? "Context Review Cycle completed with warnings."
          : "Context Review Cycle completed.",
        output_json: canonicalRunOutput({
          success: true,
          outputText: reviewResult.degraded
            ? "Context Review Cycle completed with warnings."
            : "Context Review Cycle completed.",
          outputJson: {
            automation_target: TARGET_TYPE,
            context_ops_review_cycle: reviewResult,
          },
        }),
        exit_code: 0,
        completed_at: new Date().toISOString(),
      });
      if (context.advanceSchedule) {
        await new PgAutomationRepository(client).advanceSchedule(automation);
      }
      return reviewResult;
    });
    return {
      run_id: started.runId,
      automation_run_id: started.automationRunId,
      trigger_origin: "automation",
      preflight_executable: Boolean(preflightSnapshot.executable),
      target_type: TARGET_TYPE,
      artifact_id: result.artifact_id,
      proposal_id: result.claim_candidates.proposal_id,
      artifact_ids: {
        context_review_cycle_report: result.artifact_id,
        retrieval_maintenance: result.retrieval_maintenance.artifact_id,
        diagnostics: result.diagnostics.artifact_id,
        memory_maintenance: result.memory_maintenance.artifact_id,
        claim_candidates: result.claim_candidates.artifact_id,
      },
      proposal_ids: {
        retrieval_maintenance: result.retrieval_maintenance.proposal_id,
        diagnostics: result.diagnostics.proposal_id,
        memory_maintenance: result.memory_maintenance.proposal_id,
        claim_candidates: result.claim_candidates.proposal_id,
      },
      finding_count:
        result.retrieval_maintenance.finding_count
        + result.memory_maintenance.finding_count,
      scanned:
        result.retrieval_maintenance.scanned
        + result.memory_maintenance.scanned,
      truncated:
        result.retrieval_maintenance.truncated
        || result.memory_maintenance.truncated,
      degraded: result.degraded,
      warnings: result.warnings,
    };
  } catch (error) {
    await withTransaction(pool, async (client) => {
      await new PgRunRepository(client).markRunTerminal({
        run_id: started.runId,
        space_id: fireInput.spaceId,
        status: "failed",
        output_text: "Context Review Cycle failed.",
        output_json: canonicalRunOutput({
          success: false,
          outputText: "Context Review Cycle failed.",
          outputJson: { automation_target: TARGET_TYPE },
        }),
        error_json: {
          error_code: "context_ops_review_cycle_automation_failed",
          error_text: error instanceof Error ? error.message : "Context review cycle failed",
        },
        exit_code: 1,
        completed_at: new Date().toISOString(),
      });
      if (context.advanceSchedule) {
        await new PgAutomationRepository(client).advanceSchedule(automation);
      }
    });
    if (context.advanceSchedule) {
      throw markAutomationScheduleHandled(error, "Context review cycle failed");
    }
    throw error;
  }
}

export function registerContextOpsReviewCycleAutomationTarget(): void {
  automationTargetHandlerRegistry.register(TARGET_TYPE, { preflight, execute });
}

function requestFromConfig(configJson: Record<string, unknown> | null | undefined): {
  window_days: number;
  artifact_limit: number;
  create_packets: boolean;
  review_scope: "private" | "space_ops";
  include_memory_maintenance: boolean;
  memory_limit: number;
  memory_stale_after_days: number;
  memory_thin_content_chars: number;
  memory_max_findings: number;
  max_claim_candidates: number;
} {
  const config = recordValue(configJson);
  return {
    window_days: optionalPositiveInt(config.window_days, "window_days", 14, 90),
    artifact_limit: optionalPositiveInt(config.artifact_limit, "artifact_limit", 50, 200),
    create_packets: optionalBoolean(config.create_packets, "create_packets", true),
    review_scope: optionalStringLiteral(config.review_scope, "review_scope", ["private", "space_ops"]) ?? "private",
    include_memory_maintenance: optionalBoolean(
      config.include_memory_maintenance,
      "include_memory_maintenance",
      true,
    ),
    memory_limit: optionalPositiveInt(config.memory_limit, "memory_limit", 500, 1000),
    memory_stale_after_days: optionalPositiveInt(
      config.memory_stale_after_days,
      "memory_stale_after_days",
      180,
      3650,
    ),
    memory_thin_content_chars: optionalPositiveInt(
      config.memory_thin_content_chars,
      "memory_thin_content_chars",
      80,
      1000,
    ),
    memory_max_findings: optionalPositiveInt(
      config.memory_max_findings,
      "memory_max_findings",
      100,
      200,
    ),
    max_claim_candidates: optionalPositiveInt(
      config.max_claim_candidates,
      "max_claim_candidates",
      40,
      100,
    ),
  };
}

function optionalPositiveInt(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new HttpError(
      422,
      `config_json.${field} must be a positive integer no greater than ${max}`,
    );
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpError(422, `config_json.${field} must be a boolean`);
  }
  return value;
}

function optionalStringLiteral<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(422, `config_json.${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
