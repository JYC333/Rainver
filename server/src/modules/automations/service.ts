import type { ServerConfig } from "../../config";
import type { AutomationTargetType } from "@agent-space/protocol" with { "resolution-mode": "import" };
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
import { PgRunRepository } from "../runs/repository";
import { BUILTIN_RUNTIME_ADAPTER_SPECS, type RuntimeAdapterType } from "../runtimeAdapters";
import { resolveEvolvableAssetVersion } from "../evolution/assetResolutionService";
import { WorkflowExecutionService } from "./workflowExecutionService";
import { computeNextRunAt, InvalidScheduleError } from "./schedule";
import {
  PgAutomationRepository,
  automationToOut,
  type AutomationRepositoryPort,
  type AutomationRow,
} from "./repository";
import {
  requireAutomationTargetHandler,
  type AutomationTargetExecutionContext,
  type AutomationTargetPreflightInput,
} from "./targetRegistry";
import { registerAutomationOwnedTargetHandlers } from "./targetHandlers";
import { loadAutomationTargetDefinition } from "./targetDefinitions";
import {
  automationBudgetSource,
  automationContract,
  automationScheduleWasHandled,
  lockAndCheckAutomationBudget,
} from "./targetSupport";

const VALID_TRIGGER_TYPES = new Set(["manual", "schedule"]);
const VALID_STATUSES = new Set(["active", "paused", "archived"]);
const AUTOMATION_TARGET_AGENT_RUN = "agent_run";
const AUTOMATION_TARGET_WORKFLOW = "workflow";
const AUTOMATION_TARGET_AUTONOMOUS_TICK = "autonomous_tick";
const AUTOMATION_TARGET_INFORMATION_DIGEST = "information_digest";
const DEFAULT_AUTONOMY_CRON = "0 * * * *";
const AUTONOMY_ENABLE_KEYS = new Set([
  "agent_id",
  "name",
  "observe_only",
  "autonomy_budget",
  "project_ids",
  "runtime_profile_id",
  "cron",
  "timezone",
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
    registerAutomationOwnedTargetHandlers();
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
    const targetType = await automationTargetType(configJson);
    await assertUserSelectableTarget(targetType);
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
    const nextTargetType = await automationTargetType(configJson ?? existing.config_json);
    const existingTargetType = await automationTargetType(existing.config_json);
    if (configJson && nextTargetType !== existingTargetType) {
      await assertUserSelectableTarget(nextTargetType);
    }
    const hasProjectKey = Object.prototype.hasOwnProperty.call(input.body, "project_id");
    const nextProjectId = hasProjectKey
      ? optionalString(input.body.project_id, "project_id")
      : existing.project_id;
    if (
      nextProjectId
      && nextTargetType !== AUTOMATION_TARGET_AGENT_RUN
      && nextTargetType !== AUTOMATION_TARGET_WORKFLOW
      && nextTargetType !== AUTOMATION_TARGET_INFORMATION_DIGEST
    ) {
      throw new HttpError(422, "project_id is only supported for agent_run, workflow, and Project information_digest automations");
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
      actor_is_owner: input.actorUserId === existing.owner_user_id,
    }, input.automationId);
    if (nextTargetType !== AUTOMATION_TARGET_AGENT_RUN) {
      await this.runTargetPreflight({
        targetType: nextTargetType,
        spaceId: input.spaceId,
        actorUserId: input.actorUserId,
        agentId: existing.agent_id,
        projectFolderId: existing.project_folder_id,
        projectId:
          nextTargetType === AUTOMATION_TARGET_WORKFLOW
          || nextTargetType === AUTOMATION_TARGET_INFORMATION_DIGEST
            ? nextProjectId
            : null,
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

  /**
   * Self-service enable/reconfigure of the caller's own Always-on
   * (`autonomous_tick`) Automation. `autonomous_tick` is deliberately
   * `user_selectable: false` in the target registry — it cannot be created
   * through the generic `create()` body, which accepts an open-ended
   * `config_json` for a control-plane target with a fixed shape and identity
   * model. This is the one narrow, purpose-built path around that gate: any
   * active Space member may enable their own tick, scoped to their own
   * identity and whatever Agent they already have Space access to run — the
   * same reachability rule manual Run creation already applies (no extra
   * per-Agent ownership check beyond Space membership). It is not an
   * admin/owner-only action, unlike other Automation targets.
   */
  async enableAutonomy(input: {
    spaceId: string;
    actorUserId: string;
    body: Record<string, unknown>;
  }): Promise<AutomationRow> {
    rejectExtraKeys(input.body, AUTONOMY_ENABLE_KEYS);
    const agentId = requiredString(input.body.agent_id, "agent_id");
    const name = optionalString(input.body.name, "name", 256) ?? "Always-on";
    const configJson = buildAutonomyConfigJson(input.body);
    try {
      computeNextRunAt(configJson);
    } catch (error) {
      if (error instanceof InvalidScheduleError) throw new HttpError(422, error.message);
      throw error;
    }
    await this.enforceAction("automation.create", input.spaceId, input.actorUserId, {
      agent_id: agentId,
      trigger_type: "schedule",
      target_type: AUTOMATION_TARGET_AUTONOMOUS_TICK,
      project_id: null,
      project_writer: false,
      actor_is_owner: true,
    });
    const preflightSnapshot = await this.runTargetPreflight({
      targetType: AUTOMATION_TARGET_AUTONOMOUS_TICK,
      spaceId: input.spaceId,
      actorUserId: input.actorUserId,
      agentId,
      projectFolderId: null,
      projectId: null,
      automationPreAuthorized: true,
      configJson,
    });
    return this.repo.upsertAutonomyAutomation({
      spaceId: input.spaceId,
      ownerUserId: input.actorUserId,
      agentId,
      name,
      configJson,
      preflightSnapshot,
    });
  }

  /** The caller's own Always-on Automation, or null if never enabled. */
  async getOwnAutonomyAutomation(input: {
    spaceId: string;
    actorUserId: string;
  }): Promise<AutomationRow | null> {
    const rows = await this.repo.list(input.spaceId);
    return (
      rows.find(
        (row) =>
          row.owner_user_id === input.actorUserId
          && row.config_json?.target_type === AUTOMATION_TARGET_AUTONOMOUS_TICK,
      ) ?? null
    );
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
    const targetType = await automationTargetType(auto.config_json);
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
      actor_is_owner: input.actorUserId === auto.owner_user_id,
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

    const result = await requireAutomationTargetHandler(targetType).execute({
      config: this.config,
      repo: this.repo,
      host: this,
      automation: auto,
      fireInput: input,
      triggerType,
      preflightSnapshot,
      advanceSchedule: false,
    });
    if (triggerType === "manual") {
      await this.repo.recordFire(input.spaceId, auto.id);
    }
    return result;
  }

  async scanAndFire(): Promise<number> {
    if (!this.config.databaseUrl) return 0;
    const due = await this.repo.listDue(new Date().toISOString());
    let fired = 0;
    for (const auto of due) {
      try {
        const targetType = await automationTargetType(auto.config_json);
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
          actor_is_owner: true,
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
        await requireAutomationTargetHandler(targetType).execute({
          config: this.config,
          repo: this.repo,
          host: this,
          automation: auto,
          fireInput,
          triggerType: "schedule",
          preflightSnapshot,
          advanceSchedule: true,
        });
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
        if (!automationScheduleWasHandled(error)) {
          await this.repo.advanceSchedule(auto);
        }
      }
    }
    return fired;
  }

  async executeAgentRun(
    context: AutomationTargetExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.config.databaseUrl) {
      throw new HttpError(502, "SERVER_DATABASE_URL is required");
    }
    const result = await withTransaction(getDbPool(this.config.databaseUrl), async (client) => {
      const persisted = await this.persistFire(
        client,
        context.automation,
        context.fireInput,
        context.triggerType,
        context.preflightSnapshot,
      );
      if (context.advanceSchedule) {
        await new PgAutomationRepository(client).advanceSchedule(context.automation);
      }
      return persisted;
    });
    return {
      run_id: result.runId,
      automation_run_id: result.automationRunId,
      trigger_origin: "automation",
      preflight_executable: Boolean(context.preflightSnapshot.executable),
    };
  }

  async executeWorkflow(
    context: AutomationTargetExecutionContext,
  ): Promise<Record<string, unknown>> {
    return this.executeWorkflowFire(
      context.automation,
      context.fireInput,
      context.triggerType,
      context.preflightSnapshot,
      { advanceSchedule: context.advanceSchedule },
    );
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
      const execution = await new WorkflowExecutionService(this.config).start({
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
          has_context_taint: false,
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

  private async runTargetPreflight(
    input: AutomationTargetPreflightInput,
  ): Promise<Record<string, unknown>> {
    return requireAutomationTargetHandler(input.targetType).preflight({
      config: this.config,
      repo: this.repo,
      host: this,
      input,
    });
  }

  async preflightAgentRun(
    input: AutomationTargetPreflightInput,
  ): Promise<Record<string, unknown>> {
    return this.runPreflight(
      input.spaceId,
      input.actorUserId,
      input.agentId,
      input.projectFolderId,
      input.projectId,
      input.automationPreAuthorized,
    );
  }

  async preflightWorkflow(
    input: AutomationTargetPreflightInput,
  ): Promise<Record<string, unknown>> {
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
function isUnattendedTrigger(triggerType: string): boolean {
  return triggerType === "schedule";
}

async function automationTargetType(
  configJson: Record<string, unknown> | null | undefined,
): Promise<AutomationTargetType> {
  const raw = stringValue(recordValue(configJson).target_type) ?? AUTOMATION_TARGET_AGENT_RUN;
  if (!await loadAutomationTargetDefinition(raw)) {
    throw new HttpError(422, `Unsupported automation target_type ${JSON.stringify(raw)}`);
  }
  return raw as AutomationTargetType;
}

async function assertUserSelectableTarget(targetType: AutomationTargetType): Promise<void> {
  const definition = await loadAutomationTargetDefinition(targetType);
  if (!definition?.user_selectable) {
    throw new HttpError(422, `Automation target '${targetType}' is not user-selectable`);
  }
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

function automationConfiguredPrompt(configJson: Record<string, unknown> | null | undefined): string | null {
  return stringValue(recordValue(configJson).prompt);
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

/**
 * Applies Always-on defaults (hourly cron, observe-only) on top of whatever
 * the caller supplied, then validates through the same `config_json` guard
 * as every other Automation. `admissionPolicy()` in
 * `autonomy/automationTarget.ts` separately validates budget completeness at
 * preflight time when launch mode is requested; this only shapes the input
 * and defaults, it does not duplicate that validation.
 */
function buildAutonomyConfigJson(body: Record<string, unknown>): Record<string, unknown> {
  const observeOnly = body.observe_only === undefined ? true : requiredBoolean(body.observe_only, "observe_only");
  const budget = body.autonomy_budget;
  if (budget !== undefined && (budget === null || typeof budget !== "object" || Array.isArray(budget))) {
    throw new HttpError(422, "autonomy_budget must be an object");
  }
  if (!observeOnly && budget === undefined) {
    throw new HttpError(422, "autonomy_budget is required when observe_only is false");
  }
  const projectIds = body.project_ids;
  if (projectIds !== undefined && !isStringArray(projectIds)) {
    throw new HttpError(422, "project_ids must be an array of strings");
  }
  const runtimeProfileId = optionalString(body.runtime_profile_id, "runtime_profile_id");
  return validateConfigJson({
    target_type: AUTOMATION_TARGET_AUTONOMOUS_TICK,
    observe_only: observeOnly,
    ...(budget !== undefined ? { autonomy_budget: budget } : {}),
    ...(projectIds !== undefined ? { project_ids: projectIds } : {}),
    ...(runtimeProfileId ? { runtime_profile_id: runtimeProfileId } : {}),
    cron: optionalString(body.cron, "cron") ?? DEFAULT_AUTONOMY_CRON,
    timezone: optionalString(body.timezone, "timezone") ?? "UTC",
  });
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(422, `${field} must be a boolean`);
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
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

export { automationToOut };
