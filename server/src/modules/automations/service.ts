import type { ServerConfig } from "../../config";
import {
  OperationalAlertService,
  safelyEmitOperationalAlert,
  type OperationalAlertPort,
} from "../notifications/operationalAlerts";
import { getDbPool, type PoolClient } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import { PgJobQueueRepository } from "../jobs/repository";
import { HttpError } from "../routeUtils/common";
import { enforce } from "../policy";
import { loadActionRegistry } from "../policy/actionRegistry";
import { computeDecision } from "../policy/gateway";
import { runContextReviewCycle } from "../contextOps/reviewCycle";
import {
  RetrievalMaintenanceService,
  createRetrievalMaintenanceProposalPacket,
  persistRetrievalMaintenanceReportArtifact,
} from "../retrieval";
import { readSpaceRetrievalSettings } from "../retrieval/settings";
import { knowledgeRetrievalRegistry } from "../knowledge/retrievalAdapter";
import { PgRunRepository } from "../runs/repository";
import { canonicalRunOutput } from "../runs/orchestrationResults";
import { assertBudgetSourcesAvailable } from "../runs/budgetEnforcement";
import { contractRouteHints, type RunBudgetSource } from "../runs/contractSnapshot";
import { BUILTIN_RUNTIME_ADAPTER_SPECS, type RuntimeAdapterType } from "../runtimeAdapters";
import { resolveEvolvableAssetVersion } from "../evolution/assetResolutionService";
import { lockActiveProjectForMutation } from "../projects/access";
import { WorkflowExecutionService } from "./workflowExecutionService";
import { computeNextRunAt, InvalidScheduleError } from "./schedule";
import {
  PgAutomationRepository,
  automationToOut,
  type AutomationRepositoryPort,
  type AutomationRow,
} from "./repository";

const VALID_TRIGGER_TYPES = new Set(["manual", "schedule"]);
const VALID_STATUSES = new Set(["active", "paused", "archived"]);
const AUTOMATION_TARGET_AGENT_RUN = "agent_run";
const AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE = "knowledge_retrieval_maintenance";
const AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE = "context_ops_review_cycle";
const AUTOMATION_TARGET_WORKFLOW = "workflow";
const AUTOMATION_SCHEDULE_HANDLED = Symbol("automation_schedule_handled");
const VALID_AUTOMATION_TARGETS = new Set([
  AUTOMATION_TARGET_AGENT_RUN,
  AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE,
  AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE,
  AUTOMATION_TARGET_WORKFLOW,
]);
const CREATE_KEYS = new Set([
  "name",
  "agent_id",
  "project_folder_id",
  "project_id",
  "description",
  "trigger_type",
  "config_json",
]);
const UPDATE_KEYS = new Set(["name", "description", "status", "config_json", "project_id"]);
const FORBIDDEN_CONFIG_KEYS = new Set([
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "personal_context_block",
  "approved_by_user",
  "approved_by_granting_user",
  "approval_status",
  "is_approved",
  "auto_approved",
  "pre_approved",
]);
const FORBIDDEN_COMPACT_CONFIG_KEYS = new Set([
  "apikey",
  "token",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "clientsecret",
  "personalcontextblock",
  "approvedbyuser",
  "approvedbygrantinguser",
  "approvalstatus",
  "isapproved",
  "autoapproved",
  "preapproved",
]);
const MAX_CONFIG_JSON_BYTES = 8192;
const MAX_CONFIG_DEPTH = 8;
const MAX_CONFIG_STRING_LENGTH = 2048;
const VALID_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

interface AgentPreflightRow {
  status: string;
  current_version_id: string | null;
  version_id: string | null;
  runtime_config_json: unknown;
  runtime_policy_json: unknown;
  model_provider_id: string | null;
}

export class AutomationService {
  private readonly alerts: OperationalAlertPort | null;

  constructor(
    private readonly config: ServerConfig,
    private readonly repo: AutomationRepositoryPort,
    alerts?: OperationalAlertPort | null,
  ) {
    this.alerts = alerts === undefined ? OperationalAlertService.fromConfig(config) : alerts;
  }

  async create(input: {
    spaceId: string;
    ownerUserId: string;
    body: Record<string, unknown>;
  }): Promise<AutomationRow> {
    rejectExtraKeys(input.body, CREATE_KEYS);
    const name = requiredString(input.body.name, "name", 256);
    const agentId = requiredString(input.body.agent_id, "agent_id");
    const projectFolderId = optionalString(input.body.project_folder_id, "project_folder_id");
    const projectId = optionalString(input.body.project_id, "project_id");
    const triggerType = optionalString(input.body.trigger_type, "trigger_type") ?? "manual";
    if (!VALID_TRIGGER_TYPES.has(triggerType)) {
      throw new HttpError(422, `Unsupported trigger_type ${JSON.stringify(triggerType)}`);
    }
    let configJson = validateConfigJson(input.body.config_json);
    if (triggerType === "schedule") {
      try {
        computeNextRunAt(configJson);
      } catch (error) {
        if (error instanceof InvalidScheduleError) throw new HttpError(422, error.message);
        throw error;
      }
    }
    const targetType = automationTargetType(configJson);
    configJson = await normalizeWorkflowConfig(configJson, {
      targetType,
      triggerType,
      spaceId: input.spaceId,
      userId: input.ownerUserId,
      agentId,
      projectId,
      databaseUrl: this.config.databaseUrl,
    });
    if (projectId) {
      if (targetType !== AUTOMATION_TARGET_AGENT_RUN && targetType !== AUTOMATION_TARGET_WORKFLOW) {
        throw new HttpError(422, "project_id is only supported for agent_run and workflow automations");
      }
      await this.repo.assertProjectWriter(input.spaceId, projectId, input.ownerUserId);
    }
    await this.enforceAction("automation.create", input.spaceId, input.ownerUserId, {
      agent_id: agentId,
      trigger_type: triggerType,
      target_type: targetType,
      project_id: projectId ?? null,
      project_writer: Boolean(projectId),
    });
    const preflightSnapshot = await this.runTargetPreflight({
      targetType,
      spaceId: input.spaceId,
      actorUserId: input.ownerUserId,
      agentId,
      projectFolderId,
      projectId,
      automationPreAuthorized: isUnattendedTrigger(triggerType),
      configJson,
    });
    return this.repo.create({
      spaceId: input.spaceId,
      ownerUserId: input.ownerUserId,
      name,
      description: optionalNullableString(input.body.description, "description"),
      agentId,
      projectFolderId,
      projectId,
      triggerType,
      configJson,
      preflightSnapshot,
    });
  }

  async update(input: {
    spaceId: string;
    automationId: string;
    actorUserId: string;
    body: Record<string, unknown>;
  }): Promise<AutomationRow> {
    rejectExtraKeys(input.body, UPDATE_KEYS);
    const existing = await this.repo.get(input.spaceId, input.automationId);
    if (!existing) throw new HttpError(404, `Automation '${input.automationId}' not found`);
    const status = optionalString(input.body.status, "status");
    if (status && !VALID_STATUSES.has(status)) {
      throw new HttpError(422, `Invalid status ${JSON.stringify(status)}`);
    }
    let configJson =
      Object.prototype.hasOwnProperty.call(input.body, "config_json") && input.body.config_json !== null
        ? validateConfigJson(input.body.config_json)
        : undefined;
    if (configJson && existing.trigger_type === "schedule") {
      try {
        computeNextRunAt(configJson);
      } catch (error) {
        if (error instanceof InvalidScheduleError) throw new HttpError(422, error.message);
        throw error;
      }
    }
    const nextTargetType = automationTargetType(configJson ?? existing.config_json);
    const hasProjectKey = Object.prototype.hasOwnProperty.call(input.body, "project_id");
    const nextProjectId = hasProjectKey
      ? optionalString(input.body.project_id, "project_id")
      : existing.project_id;
    if (nextProjectId && nextTargetType !== AUTOMATION_TARGET_AGENT_RUN && nextTargetType !== AUTOMATION_TARGET_WORKFLOW) {
      throw new HttpError(422, "project_id is only supported for agent_run and workflow automations");
    }
    const authorityProjectId = nextProjectId ?? existing.project_id;
    configJson = configJson
      ? await normalizeWorkflowConfig(configJson, {
          targetType: nextTargetType,
          triggerType: existing.trigger_type,
          spaceId: input.spaceId,
          userId: input.actorUserId,
          agentId: existing.agent_id,
          projectId: nextProjectId,
          databaseUrl: this.config.databaseUrl,
        })
      : configJson;
    let hasProjectWriterAuthority = false;
    if (authorityProjectId) {
      await this.repo.assertProjectWriter(input.spaceId, authorityProjectId, input.actorUserId);
      hasProjectWriterAuthority = true;
    }
    await this.enforceAction("automation.update", input.spaceId, input.actorUserId, {
      agent_id: existing.agent_id,
      target_type: nextTargetType,
      project_id: authorityProjectId ?? null,
      project_writer: hasProjectWriterAuthority,
    }, input.automationId);
    if (nextTargetType !== AUTOMATION_TARGET_AGENT_RUN) {
      await this.runTargetPreflight({
        targetType: nextTargetType,
        spaceId: input.spaceId,
        actorUserId: input.actorUserId,
        agentId: existing.agent_id,
        projectFolderId: existing.project_folder_id,
        projectId: nextTargetType === AUTOMATION_TARGET_WORKFLOW ? nextProjectId : null,
        automationPreAuthorized: isUnattendedTrigger(existing.trigger_type),
        configJson: configJson ?? existing.config_json,
      });
    }
    return this.repo.update(input.spaceId, input.automationId, {
      name: optionalString(input.body.name, "name", 256) ?? undefined,
      description:
        input.body.description === undefined
          ? undefined
          : optionalNullableString(input.body.description, "description"),
      status: status ?? undefined,
      config_json: configJson,
      project_id: hasProjectKey ? nextProjectId : undefined,
    });
  }

  async fire(input: {
    spaceId: string;
    automationId: string;
    actorUserId: string;
    prompt?: string | null;
    instruction?: string | null;
    triggerType?: string;
    triggerContext?: Record<string, unknown> | null;
  }): Promise<Record<string, unknown>> {
    const auto = await this.repo.get(input.spaceId, input.automationId);
    if (!auto) throw new HttpError(404, `Automation '${input.automationId}' not found`);
    if (auto.status !== "active") {
      throw new HttpError(409, `Automation is not active (status=${auto.status})`);
    }
    const triggerType = input.triggerType ?? "manual";
    if (!VALID_TRIGGER_TYPES.has(triggerType)) {
      throw new HttpError(422, `Unsupported trigger_type ${JSON.stringify(triggerType)}`);
    }
    const targetType = automationTargetType(auto.config_json);
    let hasProjectWriterAuthority = false;
    if (auto.project_id) {
      await this.repo.assertProjectWriter(input.spaceId, auto.project_id, input.actorUserId);
      hasProjectWriterAuthority = true;
    }
    const preAuthorized = await this.repo.hasActiveGrant(input.spaceId, auto.id);
    await this.enforceAction("automation.fire", input.spaceId, input.actorUserId, {
      agent_id: auto.agent_id,
      trigger_type: triggerType,
      trigger_origin: "automation",
      automation_pre_authorized: preAuthorized,
      target_type: targetType,
      project_id: auto.project_id ?? null,
      project_writer: hasProjectWriterAuthority,
    }, auto.id);
    const preflightSnapshot = await this.runTargetPreflight({
      targetType,
      spaceId: input.spaceId,
      actorUserId: input.actorUserId,
      agentId: auto.agent_id,
      projectFolderId: auto.project_folder_id,
      projectId: auto.project_id,
      automationPreAuthorized: preAuthorized,
      configJson: auto.config_json,
    });

    if (targetType === AUTOMATION_TARGET_WORKFLOW) {
      const result = await this.executeWorkflowFire(auto, input, triggerType, preflightSnapshot);
      if (triggerType === "manual") await this.repo.recordFire(input.spaceId, auto.id);
      return result;
    }

    if (!this.config.databaseUrl) {
      throw new HttpError(502, "SERVER_DATABASE_URL is required");
    }
    if (targetType === AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE) {
      const result = await this.executeMaintenanceFire(auto, input, triggerType, preflightSnapshot);
      if (triggerType === "manual") {
        await this.repo.recordFire(input.spaceId, auto.id);
      }
      return result;
    }
    if (targetType === AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE) {
      const result = await this.executeContextReviewCycleFire(auto, input, triggerType, preflightSnapshot);
      if (triggerType === "manual") {
        await this.repo.recordFire(input.spaceId, auto.id);
      }
      return result;
    }
    const result = await withTransaction(getDbPool(this.config.databaseUrl), async (client) => {
      return this.persistFire(client, auto, input, triggerType, preflightSnapshot);
    });
    if (triggerType === "manual") {
      await this.repo.recordFire(input.spaceId, auto.id);
    }
    return {
      run_id: result.runId,
      automation_run_id: result.automationRunId,
      trigger_origin: "automation",
      preflight_executable: Boolean(preflightSnapshot.executable),
    };
  }

  async scanAndFire(): Promise<number> {
    if (!this.config.databaseUrl) return 0;
    const pool = getDbPool(this.config.databaseUrl);
    const due = await this.repo.listDue(new Date().toISOString());
    let fired = 0;
    for (const auto of due) {
      try {
        const targetType = automationTargetType(auto.config_json);
        let hasProjectWriterAuthority = false;
        if (auto.project_id) {
          await this.repo.assertProjectWriter(auto.space_id, auto.project_id, auto.owner_user_id);
          hasProjectWriterAuthority = true;
        }
        const fireInput = {
          spaceId: auto.space_id,
          automationId: auto.id,
          actorUserId: auto.owner_user_id,
          triggerType: "schedule",
        };
        const preAuthorized = await this.repo.hasActiveGrant(auto.space_id, auto.id);
        await this.enforceAction("automation.fire", auto.space_id, auto.owner_user_id, {
          agent_id: auto.agent_id,
          trigger_type: "schedule",
          trigger_origin: "automation",
          automation_pre_authorized: preAuthorized,
          target_type: targetType,
          project_id: auto.project_id ?? null,
          project_writer: hasProjectWriterAuthority,
        }, auto.id);
        const preflightSnapshot = await this.runTargetPreflight({
          targetType,
          spaceId: auto.space_id,
          actorUserId: auto.owner_user_id,
          agentId: auto.agent_id,
          projectFolderId: auto.project_folder_id,
          projectId: auto.project_id,
          automationPreAuthorized: preAuthorized,
          configJson: auto.config_json,
        });
        if (targetType === AUTOMATION_TARGET_WORKFLOW) {
          await this.executeWorkflowFire(auto, fireInput, "schedule", preflightSnapshot, {
            advanceSchedule: true,
          });
        } else if (targetType === AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE) {
          await this.executeMaintenanceFire(auto, fireInput, "schedule", preflightSnapshot, {
            advanceSchedule: true,
          });
        } else if (targetType === AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE) {
          await this.executeContextReviewCycleFire(auto, fireInput, "schedule", preflightSnapshot, {
            advanceSchedule: true,
          });
        } else {
          await withTransaction(pool, async (client) => {
            const automations = new PgAutomationRepository(client);
            const persisted = await this.persistFire(client, auto, fireInput, "schedule", preflightSnapshot);
            await automations.advanceSchedule(auto);
            return persisted;
          });
        }
        fired += 1;
      } catch (error) {
        await safelyEmitOperationalAlert(this.alerts, {
          kind: "automation_fire_failed",
          title: `Automation failed: ${auto.name}`,
          message: `Scheduled automation ${auto.id} failed to fire: ${
            error instanceof Error ? error.message : String(error)
          }`,
          dedupeKey: `automation_fire_failed:${auto.id}`,
          spaceId: auto.space_id,
          userId: auto.owner_user_id,
          projectId: auto.project_id,
          payload: {
            automation_id: auto.id,
            automation_name: auto.name,
            trigger_type: auto.trigger_type,
          },
        });
        if (!scheduleWasHandled(error)) {
          await this.repo.advanceSchedule(auto);
        }
      }
    }
    return fired;
  }

  private async persistFire(
    client: PoolClient,
    auto: AutomationRow,
    input: {
      spaceId: string;
      actorUserId: string;
      prompt?: string | null;
      instruction?: string | null;
      triggerContext?: Record<string, unknown> | null;
    },
    triggerType: string,
    preflightSnapshot: Record<string, unknown>,
  ): Promise<{ runId: string; automationRunId: string }> {
    const runs = new PgRunRepository(client);
    const queue = new PgJobQueueRepository(client);
    const automations = new PgAutomationRepository(client);
    await lockAndCheckAutomationBudget(client, auto);

    const instruction = input.instruction ?? null;
    const prompt = input.prompt ?? automationConfiguredPrompt(auto.config_json);
    const triggerContext = input.triggerContext ?? null;

    const run = await runs.createQueuedRun({
      space_id: input.spaceId,
      user_id: input.actorUserId,
      agent_id: auto.agent_id,
      project_folder_id: auto.project_folder_id,
      project_id: auto.project_id,
      prompt,
      instruction,
      trigger_origin: "automation",
      run_type: "agent",
      mode: "live",
      contract_snapshot: automationContract(auto),
    });
    await queue.enqueue({
      job_type: "agent_run",
      payload: { run_id: run.id },
      space_id: input.spaceId,
      user_id: input.actorUserId,
      agent_id: auto.agent_id,
      project_folder_id: auto.project_folder_id,
    });
    const automationRunId = await automations.createAutomationRun({
      automationId: auto.id,
      runId: run.id,
      triggeredByUserId: input.actorUserId,
      triggerType,
      preflightSnapshot,
      triggerContext,
    });
    return { runId: run.id, automationRunId };
  }

  private async executeWorkflowFire(
    auto: AutomationRow,
    input: {
      spaceId: string;
      actorUserId: string;
      prompt?: string | null;
      instruction?: string | null;
      triggerContext?: Record<string, unknown> | null;
    },
    triggerType: string,
    preflightSnapshot: Record<string, unknown>,
    options: { advanceSchedule?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    const target = workflowTargetFromConfig(auto.config_json);
    const resolved = await resolveWorkflowTarget(this.config.databaseUrl, {
      spaceId: input.spaceId,
      userId: input.actorUserId,
      projectId: auto.project_id,
      agentId: auto.agent_id,
      target,
    });
    const executionResult = await withTransaction(getDbPool(this.config.databaseUrl), async (client) => {
      const execution = await new WorkflowExecutionService().start({
        db: client,
        identity: { spaceId: input.spaceId, userId: input.actorUserId },
        automation: auto,
        target: resolved,
        triggerType,
        prompt: input.prompt ?? automationConfiguredPrompt(auto.config_json) ?? auto.name,
        instruction: input.instruction ?? `Execute automation workflow '${auto.name}'.`,
        inputJson: target.inputJson,
        preflightSnapshot,
        triggerContext: input.triggerContext,
        budgetSources: [automationBudgetSource(auto)],
      });
      const automationRunId = await new PgAutomationRepository(client).createAutomationRun({
        automationId: auto.id,
        runId: execution.rootRunId,
        workflowExecutionId: execution.workflowExecutionId,
        triggeredByUserId: input.actorUserId,
        triggerType,
        preflightSnapshot,
        triggerContext: {
          ...(input.triggerContext ?? {}),
          target_type: AUTOMATION_TARGET_WORKFLOW,
          workflow_asset_key: target.workflowAssetKey,
          workflow_resolution: target.resolution,
          resolved_workflow_version_id: resolved.versionId,
          resolution_trace: resolved.resolutionTrace,
        },
      });
      if (options.advanceSchedule) await new PgAutomationRepository(client).advanceSchedule(auto);
      return { execution, automationRunId };
    });
    return {
      workflow_execution_id: executionResult.execution.workflowExecutionId,
      root_run_id: executionResult.execution.rootRunId,
      scheduled_node_ids: executionResult.execution.scheduledNodeIds,
      automation_run_id: executionResult.automationRunId,
      trigger_origin: "automation",
      target_type: AUTOMATION_TARGET_WORKFLOW,
      workflow_version_id: resolved.versionId,
      preflight_executable: Boolean(preflightSnapshot.executable),
    };
  }

  private async executeMaintenanceFire(
    auto: AutomationRow,
    input: {
      spaceId: string;
      actorUserId: string;
    },
    triggerType: string,
    preflightSnapshot: Record<string, unknown>,
    options: { advanceSchedule?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.config.databaseUrl) {
      throw new HttpError(502, "SERVER_DATABASE_URL is required");
    }
    const pool = getDbPool(this.config.databaseUrl);
    const started = await withTransaction(pool, async (client) => {
      const runs = new PgRunRepository(client);
      const automations = new PgAutomationRepository(client);
      await lockAndCheckAutomationBudget(client, auto);
      const run = await runs.createRunningSystemRun({
        space_id: input.spaceId,
        user_id: input.actorUserId,
        agent_id: auto.agent_id,
        project_folder_id: auto.project_folder_id,
        trigger_origin: "automation",
        prompt: "Run Knowledge retrieval maintenance scan.",
        instruction: "Persist an owner-private maintenance report and optionally create a review packet.",
        capability_id: "knowledge.retrieval.maintenance",
        capabilities_json: ["knowledge.retrieval.maintenance"],
        source: triggerType === "schedule" ? "scheduled" : "managed",
        contract_snapshot: automationContract(auto),
      });
      const automationRunId = await automations.createAutomationRun({
        automationId: auto.id,
        runId: run.id,
        triggeredByUserId: input.actorUserId,
        triggerType,
        preflightSnapshot,
      });
      return { runId: run.id, automationRunId };
    });

    try {
      const report = await new RetrievalMaintenanceService(
        pool,
        knowledgeRetrievalRegistry,
      ).scan(input.spaceId, input.actorUserId);
      const settings = await readSpaceRetrievalSettings(pool, input.spaceId);
      const createPacket = shouldCreateMaintenancePacket(auto.config_json);
      const persisted = await withTransaction(pool, async (client) => {
        const contextInput = {
          spaceId: input.spaceId,
          ownerUserId: input.actorUserId,
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
        const artifactId = await persistRetrievalMaintenanceReportArtifact(client, contextInput);
        const proposalId = createPacket
          ? await createRetrievalMaintenanceProposalPacket(client, {
              ...contextInput,
              artifactId,
            })
          : undefined;
        await new PgRunRepository(client).markRunTerminal({
          run_id: started.runId,
          space_id: input.spaceId,
          status: "succeeded",
          output_text: `Knowledge retrieval maintenance scan completed with ${report.findings.length} finding(s).`,
          output_json: canonicalRunOutput({
            success: true,
            outputText: `Knowledge retrieval maintenance scan completed with ${report.findings.length} finding(s).`,
            outputJson: {
            automation_target: AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE,
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
        if (options.advanceSchedule) {
          await new PgAutomationRepository(client).advanceSchedule(auto);
        }
        return { artifactId, proposalId };
      });
      return {
        run_id: started.runId,
        automation_run_id: started.automationRunId,
        trigger_origin: "automation",
        preflight_executable: Boolean(preflightSnapshot.executable),
        target_type: AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE,
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
          space_id: input.spaceId,
          status: "failed",
          output_text: "Knowledge retrieval maintenance scan failed.",
          output_json: canonicalRunOutput({
            success: false,
            outputText: "Knowledge retrieval maintenance scan failed.",
            outputJson: { automation_target: AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE },
          }),
          error_json: {
            error_code: "retrieval_maintenance_automation_failed",
            error_text: error instanceof Error ? error.message : "Maintenance scan failed",
          },
          exit_code: 1,
          completed_at: new Date().toISOString(),
        });
        if (options.advanceSchedule) {
          await new PgAutomationRepository(client).advanceSchedule(auto);
        }
      });
      if (options.advanceSchedule) {
        throw markScheduleHandled(error);
      }
      throw error;
    }
  }

  private async executeContextReviewCycleFire(
    auto: AutomationRow,
    input: {
      spaceId: string;
      actorUserId: string;
    },
    triggerType: string,
    preflightSnapshot: Record<string, unknown>,
    options: { advanceSchedule?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.config.databaseUrl) {
      throw new HttpError(502, "SERVER_DATABASE_URL is required");
    }
    const pool = getDbPool(this.config.databaseUrl);
    const started = await withTransaction(pool, async (client) => {
      const runs = new PgRunRepository(client);
      const automations = new PgAutomationRepository(client);
      await lockAndCheckAutomationBudget(client, auto);
      const run = await runs.createRunningSystemRun({
        space_id: input.spaceId,
        user_id: input.actorUserId,
        agent_id: auto.agent_id,
        project_folder_id: auto.project_folder_id,
        trigger_origin: "automation",
        prompt: "Run Context Review Cycle.",
        instruction: "Persist aggregate Context Ops reports and review packets without direct canonical writes.",
        capability_id: "context_ops.review_cycle",
        capabilities_json: ["context_ops.review_cycle"],
        source: triggerType === "schedule" ? "scheduled" : "managed",
        contract_snapshot: automationContract(auto),
      });
      const automationRunId = await automations.createAutomationRun({
        automationId: auto.id,
        runId: run.id,
        triggeredByUserId: input.actorUserId,
        triggerType,
        preflightSnapshot,
      });
      return { runId: run.id, automationRunId };
    });

    try {
      const request = reviewCycleRequestFromConfig(auto.config_json);
      const result = await withTransaction(pool, async (client) => {
        const reviewResult = await runContextReviewCycle(client, {
          spaceId: input.spaceId,
          userId: input.actorUserId,
          request,
          runId: started.runId,
        });
        const terminalStatus = reviewResult.degraded ? "degraded" : "succeeded";
        await new PgRunRepository(client).markRunTerminal({
          run_id: started.runId,
          space_id: input.spaceId,
          status: terminalStatus,
          output_text: reviewResult.degraded
            ? "Context Review Cycle completed with warnings."
            : "Context Review Cycle completed.",
          output_json: canonicalRunOutput({
            success: true,
            outputText: reviewResult.degraded
              ? "Context Review Cycle completed with warnings."
              : "Context Review Cycle completed.",
            outputJson: {
            automation_target: AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE,
            context_ops_review_cycle: reviewResult,
            },
          }),
          exit_code: 0,
          completed_at: new Date().toISOString(),
        });
        if (options.advanceSchedule) {
          await new PgAutomationRepository(client).advanceSchedule(auto);
        }
        return reviewResult;
      });
      return {
        run_id: started.runId,
        automation_run_id: started.automationRunId,
        trigger_origin: "automation",
        preflight_executable: Boolean(preflightSnapshot.executable),
        target_type: AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE,
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
          result.retrieval_maintenance.finding_count +
          result.memory_maintenance.finding_count,
        scanned:
          result.retrieval_maintenance.scanned +
          result.memory_maintenance.scanned,
        truncated:
          result.retrieval_maintenance.truncated ||
          result.memory_maintenance.truncated,
        degraded: result.degraded,
        warnings: result.warnings,
      };
    } catch (error) {
      await withTransaction(pool, async (client) => {
        await new PgRunRepository(client).markRunTerminal({
          run_id: started.runId,
          space_id: input.spaceId,
          status: "failed",
          output_text: "Context Review Cycle failed.",
          output_json: canonicalRunOutput({
            success: false,
            outputText: "Context Review Cycle failed.",
            outputJson: { automation_target: AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE },
          }),
          error_json: {
            error_code: "context_ops_review_cycle_automation_failed",
            error_text: error instanceof Error ? error.message : "Context review cycle failed",
          },
          exit_code: 1,
          completed_at: new Date().toISOString(),
        });
        if (options.advanceSchedule) {
          await new PgAutomationRepository(client).advanceSchedule(auto);
        }
      });
      if (options.advanceSchedule) {
        throw markScheduleHandled(error, "Context review cycle failed");
      }
      throw error;
    }
  }

  private async enforceAction(
    action: string,
    spaceId: string,
    actorUserId: string,
    context: Record<string, unknown>,
    resourceId?: string,
  ): Promise<void> {
    const membershipRole = await this.repo.getMembershipRole(spaceId, actorUserId);
    const registry = await loadActionRegistry();
    const result = await enforce(this.config, registry, {
      action,
      actor_type: "user",
      actor_id: actorUserId,
      space_id: spaceId,
      resource_type: "automation",
      resource_id: resourceId ?? null,
      context: { ...context, membership_role: membershipRole ?? "guest" },
      force_record: false,
    });
    if (result.status === "blocked") {
      throw new HttpError(403, result.message ?? "Policy denied");
    }
    if (result.status === "error") {
      throw new HttpError(500, result.message ?? "Policy audit failed");
    }
  }

  private async runPreflight(
    spaceId: string,
    actorUserId: string,
    agentId: string,
    projectFolderId: string | null | undefined,
    projectId: string | null | undefined,
    automationPreAuthorized: boolean,
  ): Promise<Record<string, unknown>> {
    if (!this.config.databaseUrl) return { executable: true, skipped: "database_not_configured" };
    const db = getDbPool(this.config.databaseUrl);
    const agent = await db.query<AgentPreflightRow>(
      `SELECT a.status,
              a.current_version_id,
              av.id AS version_id,
              av.runtime_config_json,
              av.runtime_policy_json,
              av.model_provider_id
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id AND av.space_id = a.space_id
        WHERE a.space_id = $1 AND a.id = $2`,
      [spaceId, agentId],
    );
    const row = agent.rows[0];
    const runtimeErrors: string[] = [];
    const runtimeWarnings: string[] = [];
    let adapterType: string | null = null;
    let riskLevel: string | null = null;
    let requiredSandboxLevel: string | null = null;
    let modelProviderId: string | null = null;
    let projectPreflight: Record<string, unknown> | null = null;

    if (!row) {
      runtimeErrors.push("Agent not found");
    } else {
      if (row.status !== "active") runtimeErrors.push(`Agent is not active (status=${row.status})`);
      if (!row.current_version_id) runtimeErrors.push("Agent has no current version");
      if (row.current_version_id && !row.version_id) runtimeErrors.push("Current AgentVersion not found");

      const runtimeConfig = recordValue(row.runtime_config_json);
      const runtimePolicy = recordValue(row.runtime_policy_json);
      adapterType =
        stringValue(runtimeConfig.adapter_type) ??
        stringValue(runtimePolicy.default_adapter_type) ??
        "model_api";
      riskLevel = normalizeRiskLevel(runtimePolicy.risk_level);
      const spec = runtimeAdapterSpec(adapterType);
      requiredSandboxLevel = requiredSandboxFor(riskLevel, spec);
      if (!spec) {
        runtimeErrors.push(`Unknown runtime adapter '${adapterType}'`);
      } else if (spec.implementation_status !== "implemented") {
        runtimeErrors.push(`Runtime adapter '${adapterType}' is not implemented`);
      }
      if (requiredSandboxLevel === "one_shot_docker") {
        if (!spec?.sandbox.supports_one_shot_docker) {
          runtimeErrors.push(`Runtime adapter '${adapterType}' does not support one_shot_docker sandbox execution`);
        }
      }
      if (spec?.sandbox.requires_workspace_for_execution && !projectFolderId) {
        runtimeErrors.push(`Runtime adapter '${adapterType}' requires project_folder_id`);
      }
      if (
        spec?.sandbox.requires_file_access
        && (requiredSandboxLevel === "read_only" || requiredSandboxLevel === "worktree")
        && !projectFolderId
      ) {
        runtimeErrors.push("project_folder_id is required for worktree-level runs");
      }
      if (projectFolderId) {
        const folder = await db.query<{ id: string }>(
          `SELECT id FROM project_folders WHERE space_id = $1 AND id = $2`,
          [spaceId, projectFolderId],
        );
        if (!folder.rows[0]) runtimeErrors.push("Project Folder not found");
      }
      if (projectId) {
        const projectExists = await this.repo.projectInSpace(spaceId, projectId);
        const actorHasWriterAuthority = projectExists
          ? await this.repo.canWriteProject(spaceId, projectId, actorUserId)
          : false;
        projectPreflight = {
          id: projectId,
          exists: projectExists,
          actor_has_writer_authority: actorHasWriterAuthority,
        };
        if (!projectExists) {
          runtimeErrors.push("Project not found");
        } else if (!actorHasWriterAuthority) {
          runtimeErrors.push("Project writer authority is required");
        }
      }
      modelProviderId = row.model_provider_id ?? null;
      if (!modelProviderId && spec?.model.model_provider_mode === "required") {
        modelProviderId = await resolveDefaultProvider(db, spaceId, adapterType);
        if (!modelProviderId) {
          runtimeErrors.push(`Runtime adapter '${adapterType}' requires a model provider`);
        }
      }
    }

    const registry = await loadActionRegistry();
    const policyChecks: Record<string, unknown>[] = [];
    const runtimeExecute = computeDecision(registry, {
      action: "runtime.execute",
      actor_type: "run",
      actor_id: null,
      space_id: spaceId,
      resource_space_id: spaceId,
      resource_type: "agent",
      resource_id: agentId,
      context: {
        trigger_origin: "automation",
        agent_status: row?.status,
        risk_level: riskLevel ?? "medium",
        adapter_type: adapterType,
      },
      force_record: false,
    }).decision;
    policyChecks.push(policyCheck("runtime.execute", runtimeExecute));

    if (modelProviderId) {
      const credential = computeDecision(registry, {
        action: "runtime.use_credential",
        actor_type: "run",
        actor_id: null,
        space_id: spaceId,
        resource_space_id: spaceId,
        resource_type: "model_provider",
        resource_id: modelProviderId,
        context: {
          trigger_origin: "automation",
          automation_pre_authorized: automationPreAuthorized,
        },
        force_record: false,
      }).decision;
      policyChecks.push(policyCheck("runtime.use_credential", credential));
    }

    for (const action of ["context.inject_memory", "context.render_for_runtime"]) {
      const decision = computeDecision(registry, {
        action,
        actor_type: "run",
        actor_id: null,
        space_id: spaceId,
        resource_space_id: spaceId,
        resource_type: action === "context.inject_memory" ? "memory" : "context",
        context: {
          trigger_origin: "automation",
          has_personal_grant_context: false,
        },
        metadata_json: {
          project_folder_id: projectFolderId ?? null,
          adapter_type: adapterType,
        },
        force_record: false,
      }).decision;
      policyChecks.push(policyCheck(action, decision));
    }

    const policyErrors = policyChecks
      .filter((check) => check.allowed !== true)
      .map((check) => `${check.action}: ${check.decision} (${check.reason_code ?? "policy_denied"}) ${check.message ?? ""}`.trim());
    const snapshot = {
      executable: runtimeErrors.length === 0 && policyErrors.length === 0,
      runtime_preflight: {
        executable: runtimeErrors.length === 0,
        adapter_type: adapterType,
        required_sandbox_level: requiredSandboxLevel,
        project: projectPreflight,
        errors: runtimeErrors,
        warnings: runtimeWarnings,
      },
      policy_preflight: {
        executable: policyErrors.length === 0,
        checks: policyChecks,
        errors: policyErrors,
        warnings: [],
      },
    };
    if (!snapshot.executable) {
      throw new HttpError(422, `Preflight failed: ${[...runtimeErrors, ...policyErrors].join("; ")}`);
    }
    return snapshot;
  }

  private async runTargetPreflight(input: {
    targetType: AutomationTargetType;
    spaceId: string;
    actorUserId: string;
    agentId: string;
    projectFolderId: string | null | undefined;
    projectId: string | null | undefined;
    automationPreAuthorized: boolean;
    configJson: Record<string, unknown> | null | undefined;
  }): Promise<Record<string, unknown>> {
    if (input.targetType === AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE) {
      return this.runMaintenancePreflight(
        input.spaceId,
        input.actorUserId,
        input.agentId,
        shouldCreateMaintenancePacket(input.configJson),
      );
    }
    if (input.targetType === AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE) {
      return this.runContextReviewCyclePreflight(
        input.spaceId,
        input.actorUserId,
        input.agentId,
        reviewCycleRequestFromConfig(input.configJson),
      );
    }
    if (input.targetType === AUTOMATION_TARGET_WORKFLOW) {
      return this.runWorkflowPreflight(input);
    }
    return this.runPreflight(
      input.spaceId,
      input.actorUserId,
      input.agentId,
      input.projectFolderId,
      input.projectId,
      input.automationPreAuthorized,
    );
  }

  private async runMaintenancePreflight(
    spaceId: string,
    actorUserId: string,
    agentId: string,
    createPacket: boolean,
  ): Promise<Record<string, unknown>> {
    const membershipRole = await this.repo.getMembershipRole(spaceId, actorUserId);
    const errors: string[] = [];
    let hasPermissionError = false;
    if (membershipRole !== "owner" && membershipRole !== "admin") {
      hasPermissionError = true;
      errors.push("Knowledge retrieval maintenance automation requires space owner or admin authority");
    }
    const agent = await this.repo.getAgentPreflight(spaceId, agentId);
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
      target_type: AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE,
      maintenance_preflight: {
        executable: errors.length === 0,
        scope: "knowledge",
        attribution_agent_id: agentId,
        attribution_agent_status: agent?.status ?? null,
        attribution_agent_version_id: agent?.current_version_id ?? null,
        persist_report: true,
        create_packet: createPacket,
        membership_role: membershipRole ?? "guest",
        errors,
        warnings: this.config.databaseUrl ? [] : ["SERVER_DATABASE_URL is not configured"],
      },
    };
    if (errors.length) {
      throw new HttpError(hasPermissionError ? 403 : 422, errors.join("; "));
    }
    return snapshot;
  }

  private async runContextReviewCyclePreflight(
    spaceId: string,
    actorUserId: string,
    agentId: string,
    request: ReturnType<typeof reviewCycleRequestFromConfig>,
  ): Promise<Record<string, unknown>> {
    const membershipRole = await this.repo.getMembershipRole(spaceId, actorUserId);
    const errors: string[] = [];
    let hasPermissionError = false;
    if (membershipRole !== "owner" && membershipRole !== "admin") {
      hasPermissionError = true;
      errors.push("Context Review Cycle automation requires space owner or admin authority");
    }
    if (request.review_scope === "space_ops" && this.config.databaseUrl) {
      const settings = await readSpaceRetrievalSettings(getDbPool(this.config.databaseUrl), spaceId);
      if (settings.contextOpsReviewMode === "private_only") {
        errors.push("Context Review Cycle space_ops review requires Context Ops review mode to allow admins");
      }
    }
    const agent = await this.repo.getAgentPreflight(spaceId, agentId);
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
      target_type: AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE,
      context_review_cycle_preflight: {
        executable: errors.length === 0,
        scope: "context_ops",
        attribution_agent_id: agentId,
        attribution_agent_status: agent?.status ?? null,
        attribution_agent_version_id: agent?.current_version_id ?? null,
        persist_report: true,
        create_packets: request.create_packets,
        review_scope: request.review_scope,
        include_memory_maintenance: request.include_memory_maintenance,
        membership_role: membershipRole ?? "guest",
        errors,
        warnings: this.config.databaseUrl ? [] : ["SERVER_DATABASE_URL is not configured"],
      },
    };
    if (errors.length) {
      throw new HttpError(hasPermissionError ? 403 : 422, errors.join("; "));
    }
    return snapshot;
  }

  private async runWorkflowPreflight(input: {
    targetType: AutomationTargetType;
    spaceId: string;
    actorUserId: string;
    agentId: string;
    projectFolderId: string | null | undefined;
    projectId: string | null | undefined;
    automationPreAuthorized: boolean;
    configJson: Record<string, unknown> | null | undefined;
  }): Promise<Record<string, unknown>> {
    if (!this.config.databaseUrl) throw new HttpError(422, "workflow automations require a configured database");
    const target = workflowTargetFromConfig(input.configJson);
    const resolved = await resolveWorkflowTarget(this.config.databaseUrl, {
      spaceId: input.spaceId,
      userId: input.actorUserId,
      projectId: input.projectId,
      agentId: input.agentId,
      target,
    });
    const agentSnapshot = await this.runPreflight(
      input.spaceId,
      input.actorUserId,
      input.agentId,
      input.projectFolderId,
      input.projectId,
      input.automationPreAuthorized,
    );
    return {
      ...agentSnapshot,
      target_type: AUTOMATION_TARGET_WORKFLOW,
      workflow_preflight: {
        executable: true,
        workflow_asset_key: target.workflowAssetKey,
        workflow_resolution: target.resolution,
        resolved_workflow_version_id: resolved.versionId,
        resolution_trace: resolved.resolutionTrace,
        input_json: target.inputJson,
      },
    };
  }
}

type AutomationTargetType =
  | typeof AUTOMATION_TARGET_AGENT_RUN
  | typeof AUTOMATION_TARGET_KNOWLEDGE_MAINTENANCE
  | typeof AUTOMATION_TARGET_CONTEXT_OPS_REVIEW_CYCLE
  | typeof AUTOMATION_TARGET_WORKFLOW;

interface WorkflowAutomationTarget {
  workflowAssetKey: string;
  resolution: "pin" | "follow";
  workflowVersionId: string | null;
  inputJson: Record<string, unknown>;
}

interface ResolvedWorkflowTarget {
  versionId: string;
  contentJson: unknown;
  resolutionTrace: string[];
}
type ScheduleHandledError = Error & { [AUTOMATION_SCHEDULE_HANDLED]?: true };

function isUnattendedTrigger(triggerType: string): boolean {
  return triggerType === "schedule";
}

function automationTargetType(configJson: Record<string, unknown> | null | undefined): AutomationTargetType {
  const raw = stringValue(recordValue(configJson).target_type) ?? AUTOMATION_TARGET_AGENT_RUN;
  if (!VALID_AUTOMATION_TARGETS.has(raw)) {
    throw new HttpError(422, `Unsupported automation target_type ${JSON.stringify(raw)}`);
  }
  return raw as AutomationTargetType;
}

async function normalizeWorkflowConfig(
  configJson: Record<string, unknown>,
  input: {
    targetType: AutomationTargetType;
    triggerType: string;
    spaceId: string;
    userId: string;
    agentId: string;
    projectId: string | null | undefined;
    databaseUrl?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (input.targetType !== AUTOMATION_TARGET_WORKFLOW) return configJson;
  const target = workflowTargetFromConfig(configJson);
  if (input.triggerType === "schedule" && target.resolution === "follow") {
    throw new HttpError(422, "Scheduled workflow automations must use workflow_resolution='pin'");
  }
  if (target.resolution === "follow") return configJson;
  if (!input.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required for workflow automations");
  const resolved = await resolveWorkflowTarget(input.databaseUrl, {
    spaceId: input.spaceId,
    userId: input.userId,
    projectId: input.projectId,
    agentId: input.agentId,
    target,
  });
  return {
    ...configJson,
    workflow_version_id: resolved.versionId,
    workflow_resolution: "pin",
  };
}

function workflowTargetFromConfig(configJson: Record<string, unknown> | null | undefined): WorkflowAutomationTarget {
  const config = recordValue(configJson);
  const workflowAssetKey = stringValue(config.workflow_asset_key);
  if (!workflowAssetKey) throw new HttpError(422, "workflow automation requires config_json.workflow_asset_key");
  const resolution = config.workflow_resolution;
  if (resolution !== "pin" && resolution !== "follow") {
    throw new HttpError(422, "workflow automation requires workflow_resolution='pin' or 'follow'");
  }
  const workflowVersionId = stringValue(config.workflow_version_id);
  if (resolution === "pin" && config.workflow_version_id !== undefined && !workflowVersionId) {
    throw new HttpError(422, "workflow_version_id must be a non-empty string when provided");
  }
  const rawInput = config.input_json;
  if (rawInput !== undefined && (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput))) {
    throw new HttpError(422, "config_json.input_json must be an object");
  }
  return {
    workflowAssetKey,
    resolution,
    workflowVersionId,
    inputJson: (rawInput as Record<string, unknown> | undefined) ?? {},
  };
}

async function resolveWorkflowTarget(
  databaseUrl: string,
  input: {
    spaceId: string;
    userId: string;
    projectId: string | null | undefined;
    agentId: string | null | undefined;
    target: WorkflowAutomationTarget;
  },
): Promise<ResolvedWorkflowTarget> {
  const resolved = await resolveEvolvableAssetVersion(getDbPool(databaseUrl), {
    spaceId: input.spaceId,
    userId: input.userId,
    projectId: input.projectId,
    agentId: input.agentId,
    assetKey: input.target.workflowAssetKey,
    assetType: "workflow_template",
    explicitVersionId: input.target.resolution === "pin" ? input.target.workflowVersionId : null,
  });
  return {
    versionId: resolved.versionId,
    contentJson: resolved.contentJson,
    resolutionTrace: resolved.resolutionTrace,
  };
}

function shouldCreateMaintenancePacket(configJson: Record<string, unknown> | null | undefined): boolean {
  return recordValue(configJson).create_packet === true;
}

function reviewCycleRequestFromConfig(configJson: Record<string, unknown> | null | undefined): {
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
  const reviewScope = optionalStringLiteral(config.review_scope, "review_scope", ["private", "space_ops"]) ?? "private";
  return {
    window_days: optionalPositiveInt(config.window_days, "window_days", 14, 90),
    artifact_limit: optionalPositiveInt(config.artifact_limit, "artifact_limit", 50, 200),
    create_packets: optionalBoolean(config.create_packets, "create_packets", true),
    review_scope: reviewScope,
    include_memory_maintenance: optionalBoolean(config.include_memory_maintenance, "include_memory_maintenance", true),
    memory_limit: optionalPositiveInt(config.memory_limit, "memory_limit", 500, 1000),
    memory_stale_after_days: optionalPositiveInt(config.memory_stale_after_days, "memory_stale_after_days", 180, 3650),
    memory_thin_content_chars: optionalPositiveInt(config.memory_thin_content_chars, "memory_thin_content_chars", 80, 1000),
    memory_max_findings: optionalPositiveInt(config.memory_max_findings, "memory_max_findings", 100, 200),
    max_claim_candidates: optionalPositiveInt(config.max_claim_candidates, "max_claim_candidates", 40, 100),
  };
}

function automationConfiguredPrompt(configJson: Record<string, unknown> | null | undefined): string | null {
  return stringValue(recordValue(configJson).prompt);
}

function optionalPositiveInt(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new HttpError(422, `config_json.${field} must be a positive integer no greater than ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new HttpError(422, `config_json.${field} must be a boolean`);
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

function markScheduleHandled(error: unknown, fallbackMessage = "Maintenance scan failed"): Error {
  const marked: ScheduleHandledError = error instanceof Error
    ? (error as ScheduleHandledError)
    : (new Error(fallbackMessage) as ScheduleHandledError);
  marked[AUTOMATION_SCHEDULE_HANDLED] = true;
  return marked;
}

function scheduleWasHandled(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as Partial<ScheduleHandledError>)[AUTOMATION_SCHEDULE_HANDLED],
  );
}

function rejectExtraKeys(body: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HttpError(422, `Unsupported field ${JSON.stringify(key)}`);
  }
}

function requiredString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new HttpError(422, `${field} must be a non-empty string`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new HttpError(422, `${field} exceeds maximum length of ${maxLength}`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength?: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(422, `${field} must be a string`);
  if (value.length < 1) throw new HttpError(422, `${field} must not be empty`);
  if (maxLength !== undefined && value.length > maxLength) {
    throw new HttpError(422, `${field} exceeds maximum length of ${maxLength}`);
  }
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(422, `${field} must be a string`);
  return value;
}

function validateConfigJson(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "config_json must be an object");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new HttpError(422, "config_json must be JSON serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONFIG_JSON_BYTES) {
    throw new HttpError(422, `config_json exceeds maximum serialized size of ${MAX_CONFIG_JSON_BYTES} bytes`);
  }
  walkConfigJson(value, 1);
  return value as Record<string, unknown>;
}

function walkConfigJson(value: unknown, depth: number): void {
  if (depth > MAX_CONFIG_DEPTH) {
    throw new HttpError(422, `config_json exceeds maximum depth of ${MAX_CONFIG_DEPTH}`);
  }
  if (Array.isArray(value)) {
    for (const item of value) walkConfigJson(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenConfigKey(key)) {
        throw new HttpError(422, `config_json contains forbidden key ${JSON.stringify(key)}`);
      }
      walkConfigJson(child, depth + 1);
    }
    return;
  }
  if (typeof value === "string" && value.length > MAX_CONFIG_STRING_LENGTH) {
    throw new HttpError(422, `config_json string exceeds maximum length of ${MAX_CONFIG_STRING_LENGTH}`);
  }
}

function isForbiddenConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  if (FORBIDDEN_CONFIG_KEYS.has(lower) || FORBIDDEN_COMPACT_CONFIG_KEYS.has(compact)) {
    return true;
  }
  if (compact.endsWith("token") && compact !== "maxtoken") return true;
  return (
    compact.includes("secret") ||
    compact.includes("password") ||
    compact.includes("credential")
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeRiskLevel(value: unknown): string {
  return typeof value === "string" && VALID_RISK_LEVELS.has(value) ? value : "medium";
}

function runtimeAdapterSpec(adapterType: string | null) {
  if (!adapterType) return null;
  return BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType as RuntimeAdapterType] ?? null;
}

function requiredSandboxFor(
  riskLevel: string,
  spec: ReturnType<typeof runtimeAdapterSpec>,
): string {
  if (riskLevel === "critical") return "one_shot_docker";
  if (riskLevel === "high") return "worktree";
  if (spec?.sandbox.requires_file_access) return "read_only";
  return "none";
}

async function resolveDefaultProvider(
  db: { query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }> },
  spaceId: string,
  adapterType: string,
): Promise<string | null> {
  const result = await db.query<{ id: string; config_json: unknown }>(
    `SELECT id, config_json
       FROM model_providers
      WHERE space_id = $1 AND enabled = TRUE`,
    [spaceId],
  );
  let spaceDefault: string | null = null;
  for (const row of result.rows) {
    const cfg = recordValue(row.config_json);
    if (cfg.runtime_default_for === adapterType) return row.id;
    if (cfg.runtime_default_adapter_type === adapterType) return row.id;
    if (Array.isArray(cfg.runtime_default_adapter_types) && cfg.runtime_default_adapter_types.includes(adapterType)) {
      return row.id;
    }
    const defaults = recordValue(cfg.runtime_defaults);
    if (defaults[adapterType] === true) return row.id;
    if (spaceDefault === null && cfg.is_default === true) spaceDefault = row.id;
  }
  return spaceDefault;
}

function policyCheck(action: string, decision: {
  decision: string;
  message?: string | null;
  reason_code?: string | null;
  policy_rule_id?: string | null;
  audit_code?: string | null;
}): Record<string, unknown> {
  return {
    action,
    decision: decision.decision,
    allowed: decision.decision === "allow",
    reason_code: decision.reason_code ?? null,
    policy_rule_id: decision.policy_rule_id ?? null,
    audit_code: decision.audit_code ?? null,
    message: decision.message ?? null,
  };
}

function automationContract(auto: AutomationRow) {
  const config = recordValue(auto.config_json);
  const declared = recordValue(config.contract_json ?? config.contract);
  const value = (key: string): unknown => declared[key] ?? config[key] ?? null;
  const definitionOfDone = value("definition_of_done");
  return {
    source: { kind: "automation" as const, id: auto.id },
    project_id: auto.project_id,
    project_folder_id: auto.project_folder_id,
    acceptance_criteria_json: value("acceptance_criteria_json"),
    definition_of_done: typeof definitionOfDone === "string" ? definitionOfDone : null,
    required_outputs_json: value("required_outputs_json"),
    risk_level: normalizeRiskLevel(value("risk_level")),
    max_runs: positiveIntegerOrNull(value("max_runs")),
    max_attempts: positiveIntegerOrNull(value("max_attempts")),
    max_cost: nonNegativeNumberOrNull(value("max_cost")),
    max_duration_seconds: positiveIntegerOrNull(value("max_duration_seconds")),
    budget_precedence: nonNegativeNumberOrNull(value("budget_precedence")),
    route_hints_json: contractRouteHints(declared) ?? contractRouteHints(config),
  };
}

function automationBudgetSource(auto: AutomationRow): RunBudgetSource {
  const contract = automationContract(auto);
  return {
    source: { kind: "automation", id: auto.id },
    precedence: contract.budget_precedence,
    max_runs: contract.max_runs,
    max_attempts: contract.max_attempts,
    max_cost: contract.max_cost,
    max_duration_seconds: contract.max_duration_seconds,
  };
}

async function lockAndCheckAutomationBudget(client: PoolClient, auto: AutomationRow): Promise<void> {
  if (auto.project_id) await lockActiveProjectForMutation(client, auto.space_id, auto.project_id);
  await client.query(
    `SELECT id FROM automations WHERE space_id = $1 AND id = $2 FOR UPDATE`,
    [auto.space_id, auto.id],
  );
  const source = automationBudgetSource(auto);
  if (source.max_runs === null || source.max_runs === undefined) return;
  await assertBudgetSourcesAvailable(client, auto.space_id, [source]);
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export { automationToOut };
