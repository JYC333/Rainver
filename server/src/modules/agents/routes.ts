import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type {
  MessageOut,
} from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import type { Pool, PoolClient } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { PgSessionRepository } from "../sessions/repository.js";
import {
  ConversationBackendError,
  PgConversationBackendRepository,
  type ResolvedConversationBackend,
} from "../sessions/conversationBackendRepository.js";
import {
  ConversationTurnInProgressError,
  PgConversationRuntimeSessionRepository,
} from "../sessions/conversationRuntimeSessionRepository.js";
import { removeConversationRuntimeState } from "../runs/conversationRuntimeState.js";
import {
  PgRunRepository,
  RunCreateValidationError,
} from "../runs/repository.js";
import { runToOut } from "../runs/runReadModel.js";
import { resolveRunRemoteness } from "../runs/runRemoteness.js";
import { RunBudgetExceededError, RunBudgetSourceReferenceError } from "../runs/budgetEnforcement.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import {
  dbPool,
  parsePage,
  query as routeQuery,
  sendRouteError,
} from "../routeUtils/common.js";
import { PgProposalRepository } from "../proposals/repository.js";
import { PgAgentChatRepository, PgAgentRepository } from "./repository.js";
import { isLocalCliRuntimeAdapter } from "../runtimeAdapters/index.js";
import { resolveContentCreationContext } from "../access/creationContext.js";
import { prepareHostConversationDispatch } from "../agentGroups/service.js";
import { renderAgentIdentityPrompt } from "../agentGroups/agentIdentityPrompt.js";
import { TERMINAL_RUN_STATUSES } from "../runs/orchestrationResults.js";
import { assertProjectReadable } from "../projects/access.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import { sharedHostConnectionRegistry } from "../hosts/connectionRegistry.js";
import {
  applyAgentIdentityPatch,
  configPatch,
  hasConfigPatch,
  jsonBody,
  nullableBodyString,
  optionalArrayBody,
  optionalBooleanBody,
  optionalRecordBody,
  params,
  requiredBodyString,
  sendDomainError,
  stringValue,
} from "./agentRouteInputs.js";
import { conversationToolGrantInput } from "../systemActions/scenarioToolAllowance.js";

const MAX_MESSAGE_CHARS = 8000;
class ChatContextError extends Error {
  constructor(readonly body: string, readonly statusCode: number) {
    super(body);
    this.name = "ChatContextError";
  }
}

interface AgentChatUnitOfWork {
  db?: Pool | PoolClient;
  sessions: Pick<
    PgSessionRepository,
    | "getSession"
    | "createSession"
    | "addMessage"
    | "attachRunToUserMessage"
  > & Partial<Pick<PgSessionRepository, "listMessages">>;
  backends: Pick<
    PgConversationBackendRepository,
    "resolveBinding"
  >;
  runtimeSessions: Pick<
    PgConversationRuntimeSessionRepository,
    "claimTurn" | "prepare"
  >;
  runs: Pick<PgRunRepository, "createQueuedRun">;
  hostThreads?: Pick<PgHostThreadRepository, "recordDirectDispatch">;
  jobs: {
    enqueue: (input: {
      run_id: string;
      space_id: string;
      user_id: string;
      agent_id: string;
    }) => Promise<void>;
  };
}

interface AgentChatServices extends AgentChatUnitOfWork {
  agents: Pick<PgAgentChatRepository, "getAgentForChat">;
  inTransaction<T>(
    work: (services: AgentChatUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

interface PreparedChatRun {
  run_id: string;
  retired_runtime_state_keys: string[];
  host_thread_id?: string;
}

type AgentChatServicesFactory = (context: ModuleContext) => AgentChatServices;
type AgentChatIdentity = { spaceId: string; userId: string };
type PreparedHostConversationDispatch = NonNullable<Awaited<ReturnType<typeof prepareHostConversationDispatch>>>;
type AgentChatIdentityOverride =
  | AgentChatIdentity
  | ((request: FastifyRequest) => Promise<AgentChatIdentity | null> | AgentChatIdentity | null);

let servicesFactoryOverride: AgentChatServicesFactory | null = null;
let identityOverride: AgentChatIdentityOverride | null = null;

export function __setAgentChatServicesFactoryForTests(
  factory: AgentChatServicesFactory | null,
): void {
  servicesFactoryOverride = factory;
}

export function __setAgentChatIdentityForTests(
  identity: AgentChatIdentityOverride | null,
): void {
  identityOverride = identity;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const agentRepository = () => PgAgentRepository.fromConfig(context.config);

  app.get("/api/v1/agents/runs", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const q = routeQuery(request);
      const page = parsePage(q);
      const repository = PgRunRepository.fromConfig(context.config);
      const runs = await repository.listRuns({
        space_id: identity.spaceId,
        user_id: identity.userId,
        status: q.status ?? null,
        mode: q.mode ?? null,
        agent_id: q.agent_id ?? null,
        project_folder_id: q.project_folder_id ?? null,
        project_id: q.project_id ?? null,
        exclude_system_assistants: true,
        limit: page.limit,
        offset: page.offset,
      });
      const remote = await resolveRunRemoteness(dbPool(context.config), runs);
      return reply.send(runs.map((run) => runToOut(run, null, { executes_remotely: remote.has(run.id) })));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/runs/:runId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const repository = PgRunRepository.fromConfig(context.config);
      const run = await repository.getVisibleRun(identity.spaceId, identity.userId, params(request).runId ?? "");
      if (!run) {
        return reply.code(404).send({ detail: "Run not found in this space" });
      }
      if (!(await agentRepository().getVisible(identity.spaceId, identity.userId, run.agent_id))) {
        return reply.code(404).send({ detail: "Run not found in this space" });
      }
      return reply.send(runToOut(run, null, {
        executes_remotely: (await resolveRunRemoteness(dbPool(context.config), [run])).has(run.id),
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/:agentId/runs", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const q = routeQuery(request);
      const page = parsePage(q);
      const agentId = params(request).agentId ?? "";
      const visibleAgent = await agentRepository().getVisible(identity.spaceId, identity.userId, agentId);
      if (!visibleAgent) {
        return reply.code(404).send({ detail: "Agent not found" });
      }
      const repository = PgRunRepository.fromConfig(context.config);
      const runs = await repository.listRuns({
        space_id: identity.spaceId,
        user_id: identity.userId,
        status: q.status ?? null,
        mode: q.mode ?? null,
        agent_id: agentId,
        project_folder_id: q.project_folder_id ?? null,
        project_id: q.project_id ?? null,
        limit: page.limit,
        offset: page.offset,
      });
      const remote = await resolveRunRemoteness(dbPool(context.config), runs);
      return reply.send(runs.map((run) => runToOut(run, null, { executes_remotely: remote.has(run.id) })));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/:agentId/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const q = routeQuery(request);
      const page = parsePage(q);
      const agentId = params(request).agentId ?? "";
      const agent = await agentRepository().getVisible(identity.spaceId, identity.userId, agentId);
      if (!agent) return reply.code(404).send({ detail: "Agent not found" });
      const status = q.status === "all" ? null : q.status ?? "pending";
      const proposalRepository = new PgProposalRepository(dbPool(context.config));
      return reply.send(await proposalRepository.listVisible(identity.spaceId, identity.userId, {
        status,
        agentId,
        limit: page.limit,
        offset: page.offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // The managed Assistant instance for a scope: the Space's own (`project_id`
  // absent) or a Project's. A Project's instance exists once its first Room
  // message provisioned it; null before that, which the UI states honestly.
  app.get("/api/v1/agents/system-assistant", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const q = routeQuery(request);
      if (q.project_id) {
        await assertProjectReadable(
          dbPool(context.config),
          identity.spaceId,
          q.project_id,
          identity.userId,
        );
      }
      const assistant = await agentRepository().getSystemAssistantInTransaction(
        dbPool(context.config),
        identity.spaceId,
        q.project_id ?? null,
      );
      return reply.send({ assistant });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const q = routeQuery(request);
      const page = parsePage(q);
      const agents = await agentRepository().list(identity.spaceId, identity.userId, {
        createdByUserId: q.created_by_user_id ?? null,
        visibility: q.visibility ?? null,
        status: q.status ?? "active",
        limit: page.limit,
        offset: page.offset,
      });
      return reply.send(agents);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/agents", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: stringValue(body.project_id),
      });
      const agent = await agentRepository().create({
        spaceId: creation.spaceId,
        projectId: creation.projectId,
        userId: identity.userId,
        name: requiredBodyString(body, "name"),
        description: nullableBodyString(body, "description") ?? null,
        visibility: creation.visibility,
        roleInstruction: nullableBodyString(body, "role_instruction") ?? null,
        systemPrompt: nullableBodyString(body, "system_prompt") ?? null,
        defaultModelProviderId: nullableBodyString(body, "default_model_provider_id") ?? null,
        defaultModel: nullableBodyString(body, "default_model") ?? null,
        adapterType: nullableBodyString(body, "adapter_type") ?? null,
        modelConfigJson: optionalRecordBody(body, "model_config_json"),
        runtimeConfigJson: optionalRecordBody(body, "runtime_config_json"),
        executionHostId: nullableBodyString(body, "execution_host_id"),
        workspaceLocationId: nullableBodyString(body, "workspace_location_id"),
        workspaceMode: nullableBodyString(body, "workspace_mode") as "location" | "managed" | null,
        runtimeInstallation: nullableBodyString(body, "runtime_installation"),
        contextPolicyJson: optionalRecordBody(body, "context_policy_json"),
        memoryPolicyJson: optionalRecordBody(body, "memory_policy_json"),
        capabilitiesJson: optionalArrayBody(body, "capabilities_json"),
        toolPermissionsJson: optionalRecordBody(body, "tool_permissions_json"),
        runtimePolicyJson: optionalRecordBody(body, "runtime_policy_json"),
      });
      return reply.code(201).send(agent);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/default-assistant/settings", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await agentRepository().getAssistantSettings(identity.spaceId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/agents/default-assistant/settings", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await agentRepository().updateAssistantSettings(identity.spaceId, jsonBody(request), {
          actorUserId: identity.userId,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/:agentId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const agent = await agentRepository().getVisible(identity.spaceId, identity.userId, params(request).agentId ?? "");
      if (!agent) return reply.code(404).send({ detail: "Agent not found" });
      return reply.send(agent);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/agents/:agentId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const repo = agentRepository();
      const agentId = params(request).agentId ?? "";
      let agent = await applyAgentIdentityPatch(repo, identity.spaceId, identity.userId, agentId, body);
      if (hasConfigPatch(body)) {
        agent = await repo.updateConfig(identity.spaceId, agentId, configPatch(body, identity.userId));
      }
      if (!agent) {
        agent = await repo.get(identity.spaceId, agentId);
        if (!agent) return reply.code(404).send({ detail: "Agent not found" });
      }
      return reply.send(agent);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/agents/:agentId/config", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const agent = await agentRepository().updateConfig(
        identity.spaceId,
        params(request).agentId ?? "",
        configPatch(jsonBody(request), identity.userId),
      );
      return reply.send(agent);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/:agentId/runtime-profiles", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const repository = agentRepository();
      const agentId = params(request).agentId ?? "";
      // Runtime profiles include Host and workspace facts. Apply the owning
      // Agent/Project read boundary before exposing them; knowing an Agent id
      // must not be enough to enumerate its execution targets.
      if (!await repository.canReadRuntimeProfiles(identity.spaceId, identity.userId, agentId)) {
        return reply.code(404).send({ detail: "Agent not found" });
      }
      const profiles = await repository.listRuntimeProfiles(identity.spaceId, agentId);
      return reply.send(profiles);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/agents/:agentId/runtime-profiles", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      rejectRuntimeProfileCredential(body);
      const repository = agentRepository();
      const agentId = params(request).agentId ?? "";
      if (!await repository.canWriteRuntimeProfiles(identity.spaceId, identity.userId, agentId)) {
        return reply.code(404).send({ detail: "Agent not found" });
      }
      const profile = await repository.createRuntimeProfile(
        identity.spaceId,
        agentId,
        {
          name: requiredBodyString(body, "name"),
          adapterType: requiredBodyString(body, "adapter_type"),
          modelProviderId: nullableBodyString(body, "model_provider_id"),
          modelName: nullableBodyString(body, "model_name"),
          executionHostId: nullableBodyString(body, "execution_host_id"),
          workspaceLocationId: nullableBodyString(body, "workspace_location_id"),
          workspaceMode: nullableBodyString(body, "workspace_mode") as "location" | "managed" | null,
          runtimeInstallation: nullableBodyString(body, "runtime_installation"),
          runtimeConfigJson: optionalRecordBody(body, "runtime_config_json"),
          runtimePolicyJson: optionalRecordBody(body, "runtime_policy_json"),
          enabled: optionalBooleanBody(body, "enabled"),
          isDefault: optionalBooleanBody(body, "is_default"),
          actorUserId: identity.userId,
        },
      );
      return reply.code(201).send(profile);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/agents/:agentId/runtime-profiles/resolve-host-target", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const repository = agentRepository();
      const agentId = params(request).agentId ?? "";
      if (!await repository.canWriteRuntimeProfiles(identity.spaceId, identity.userId, agentId)) {
        return reply.code(404).send({ detail: "Agent not found" });
      }
      const workspaceMode = requiredBodyString(body, "workspace_mode") as "location" | "managed";
      if (workspaceMode !== "location" && workspaceMode !== "managed") {
        return reply.code(422).send({ detail: "workspace_mode must be location or managed" });
      }
      const profile = await repository.ensureHostRuntimeProfile({
        spaceId: identity.spaceId,
        agentId,
        actorUserId: identity.userId,
        executionHostId: requiredBodyString(body, "execution_host_id"),
        workspaceLocationId: nullableBodyString(body, "workspace_location_id"),
        workspaceMode,
        adapterType: requiredBodyString(body, "adapter_type"),
        runtimeInstallation: requiredBodyString(body, "runtime_installation"),
      });
      return reply.send(profile);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/agents/:agentId/runtime-profiles/:profileId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      rejectRuntimeProfileCredential(body);
      const repository = agentRepository();
      const agentId = params(request).agentId ?? "";
      const profileId = params(request).profileId ?? "";
      if (!await repository.canWriteRuntimeProfiles(identity.spaceId, identity.userId, agentId)) {
        return reply.code(404).send({ detail: "Agent not found" });
      }
      const profile = await repository.updateRuntimeProfile(
        identity.spaceId,
        agentId,
        profileId,
        {
          name: Object.hasOwn(body, "name") ? requiredBodyString(body, "name") : undefined,
          adapterType: Object.hasOwn(body, "adapter_type")
            ? requiredBodyString(body, "adapter_type")
            : undefined,
          modelProviderId: Object.hasOwn(body, "model_provider_id")
            ? nullableBodyString(body, "model_provider_id")
            : undefined,
          modelName: Object.hasOwn(body, "model_name")
            ? nullableBodyString(body, "model_name")
            : undefined,
          executionHostId: Object.hasOwn(body, "execution_host_id")
            ? nullableBodyString(body, "execution_host_id")
            : undefined,
          workspaceLocationId: Object.hasOwn(body, "workspace_location_id")
            ? nullableBodyString(body, "workspace_location_id")
            : undefined,
          workspaceMode: Object.hasOwn(body, "workspace_mode")
            ? nullableBodyString(body, "workspace_mode") as "location" | "managed" | null
            : undefined,
          runtimeInstallation: Object.hasOwn(body, "runtime_installation")
            ? nullableBodyString(body, "runtime_installation")
            : undefined,
          runtimeConfigJson: optionalRecordBody(body, "runtime_config_json"),
          runtimePolicyJson: optionalRecordBody(body, "runtime_policy_json"),
          enabled: optionalBooleanBody(body, "enabled"),
          isDefault: optionalBooleanBody(body, "is_default"),
          actorUserId: identity.userId,
        },
      );
      return reply.send(profile);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/:agentId/conversation-backends", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const agentId = params(request).agentId ?? "";
    const sessionId = stringValue(routeQuery(request).session_id);
    const sessions = new PgSessionRepository(dbPool(context.config));
    const visibleSession = sessionId
      ? await sessions.getConversationForBackendSelection(identity.spaceId, identity.userId, sessionId)
      : null;
    if (sessionId && !visibleSession) {
      return reply.code(404).send({ detail: "Session not found" });
    }
    const directAgent = await PgAgentChatRepository
      .fromConfig(context.config)
      .getAgentForChat(identity.spaceId, identity.userId, agentId);
    const roomParticipant = visibleSession?.room_id
      ? await dbPool(context.config).query<{ present: boolean }>(
          `SELECT true AS present
             FROM room_agent_members
            WHERE space_id = $1 AND room_id = $2 AND agent_id = $3 AND status = 'active'
            LIMIT 1`,
          [identity.spaceId, visibleSession.room_id, agentId],
        )
      : null;
    if (!directAgent && !roomParticipant?.rows[0]?.present) {
      return reply.code(404).send({ detail: "Agent not found" });
    }
    const repository = new PgConversationBackendRepository(dbPool(context.config));
    const [options, binding, sessionConfig] = await Promise.all([
      repository.listOptions(identity.spaceId, identity.userId, agentId),
      sessionId
        ? repository.findBinding(identity.spaceId, identity.userId, sessionId, agentId)
        : Promise.resolve(null),
      sessionId
        ? latestConversationSessionConfig(dbPool(context.config), identity.spaceId, sessionId, agentId)
        : Promise.resolve([]),
    ]);
    return reply.send({ options, binding, session_config: sessionConfig });
  });

  app.get("/api/v1/agents/:agentId/current-version", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const version = await agentRepository().getCurrentVersion(
        identity.spaceId,
        params(request).agentId ?? "",
      );
      if (!version) return reply.code(404).send({ detail: "Agent has no current version" });
      return reply.send(version);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/:agentId/versions", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const versions = await agentRepository().listVersions(
        identity.spaceId,
        params(request).agentId ?? "",
      );
      return reply.send(versions);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agents/:agentId/versions/:versionId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const version = await agentRepository().getVersion(
        identity.spaceId,
        p.agentId ?? "",
        p.versionId ?? "",
      );
      return reply.send(version);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/agents/:agentId/versions/:versionId/restore", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const agent = await agentRepository().restoreVersion(
        identity.spaceId,
        p.agentId ?? "",
        p.versionId ?? "",
        identity.userId,
      );
      return reply.send(agent);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  const createRun = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const agentId = params(request).agentId ?? "";
    const body = jsonBody(request);
    const repository = PgRunRepository.fromConfig(context.config);
    try {
      const projectFolderId = stringValue(body.project_folder_id);
      const projectId = stringValue(body.project_id);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId,
      });
      const visibleAgent = await PgAgentRepository
        .fromConfig(context.config)
        .getVisible(creation.spaceId, identity.userId, agentId);
      if (!visibleAgent) {
        return reply.code(404).send({ detail: `Agent '${agentId}' not found in this space` });
      }
      const resolvedProjectFolderId = creation.projectId ? projectFolderId : null;
      const run = await repository.createQueuedRunWithBudgetAdmission({
        agent_id: agentId,
        space_id: creation.spaceId,
        user_id: identity.userId,
        mode: stringValue(body.mode) ?? "live",
        run_type: stringValue(body.run_type) ?? "agent",
        trigger_origin: stringValue(body.trigger_origin) ?? "manual",
        session_id: stringValue(body.session_id),
        project_folder_id: resolvedProjectFolderId,
        project_id: creation.projectId,
        prompt: stringValue(body.prompt),
        instruction: stringValue(body.instruction),
        scheduled_at: stringValue(body.scheduled_at),
        parent_run_id: stringValue(body.parent_run_id),
        runtime_profile_id: stringValue(body.runtime_profile_id),
        capability_id: stringValue(body.capability_id),
        capabilities_json: optionalArrayBody(body, "capabilities_json"),
        workflow_version_id: null,
        visibility: creation.visibility,
      });
      return reply.code(201).send(runToOut(run, null, {
        executes_remotely: (await resolveRunRemoteness(dbPool(context.config), [run])).has(run.id),
      }));
    } catch (error) {
      if (error instanceof RunCreateValidationError) {
        return reply.code(error.statusCode).send({ detail: error.message });
      }
      if (error instanceof RunBudgetExceededError || error instanceof RunBudgetSourceReferenceError) {
        return sendRouteError(reply, error);
      }
      throw error;
    }
  };
  app.post("/api/v1/agents/:agentId/runs", createRun);
  app.post("/api/v1/agents/:agentId/run", createRun);

  app.post("/api/v1/agents/:agentId/chat/reset-context", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const agentId = params(request).agentId ?? "";
    try {
      const services = agentChatServices(context);
      const agent = await services.agents.getAgentForChat(
        identity.spaceId,
        identity.userId,
        agentId,
      );
      if (!agent) return reply.code(404).send({ detail: "Agent not found in this space" });

      const reset = await withTransaction(dbPool(context.config), async (client) => {
        const threadResult = await client.query<{
          id: string;
          execution_host_id: string | null;
          workspace_mode: "location" | "managed";
          dispatch_lock_id: string | null;
          host_owner_user_id: string | null;
        }>(
          `SELECT thread.id, thread.execution_host_id, thread.workspace_mode,
                  thread.dispatch_lock_id, host.owner_user_id AS host_owner_user_id
             FROM host_threads thread
             LEFT JOIN hosts host ON host.id = thread.execution_host_id
            WHERE thread.agent_id = $1
              AND thread.container_kind = 'direct'
              AND thread.container_user_id = $2
              AND thread.status IN ('active', 'session_reset')
            LIMIT 1
            FOR UPDATE OF thread`,
          [agent.id, identity.userId],
        );
        const thread = threadResult.rows[0];
        if (!thread) return null;
        if (thread.host_owner_user_id && thread.host_owner_user_id !== identity.userId) {
          throw new ChatContextError("Only the Host owner can reset this Agent context", 403);
        }
        if (thread.dispatch_lock_id) {
          throw new ChatContextError("The Agent is handling a message; try resetting again when it finishes", 409);
        }
        const updated = await new PgHostThreadRepository(client).resetDirectAgent(
          agent.id,
          identity.userId,
        );
        return updated ? { thread_id: updated.id, workspace_mode: updated.workspace_mode } : null;
      });
      if (!reset) return reply.code(404).send({ detail: "Direct Agent context not found" });
      return reply.send({ agent_id: agent.id, session_reset: true, ...reset });
    } catch (error) {
      if (error instanceof ChatContextError) return reply.code(error.statusCode).send({ detail: error.body });
      return sendDomainError(reply, error);
    }
  });

  /**
   * "Clear this Agent's CLI memory on this host."
   *
   * Rainver owns an Agent's identity and its distilled Memory; the vendor
   * CLI's own auto-memory, sessions and login are scratch that lives in the
   * Agent's profile on the executing machine
   * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §6).
   * This is the one action that clears that scratch: every profile the Agent
   * has on the named Host is archived — not deleted, so a person who ran it by
   * mistake still has what was there until the 30-day sweep — and no workspace
   * is touched, so the work the Agent did survives.
   *
   * Owner-only twice over: the caller must own the Host (a Host is
   * user-scoped) and, when the Agent has an owner, be that owner. A Room
   * member cannot clear someone else's Agent.
   *
   * An Agent with **no** owner — the `space_shared` Space and Project
   * Assistants — is cleared by whoever owns the Host, and that is the intended
   * reading rather than an oversight: the state being cleared is on the
   * caller's own machine, put there by their own runs, and there is no owner
   * to defer to. It matches ADR 0003 §4, where an ownerless Agent has no
   * Agent-scope Memory to protect either.
   */
  app.post("/api/v1/agents/:agentId/host-state/reset", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const agentId = params(request).agentId ?? "";
    const hostId = typeof jsonBody(request).host_id === "string" ? String(jsonBody(request).host_id) : "";
    if (!hostId) return reply.code(422).send({ detail: "host_id is required" });
    try {
      const pool = dbPool(context.config);
      const agent = await pool.query<{ id: string; owner_user_id: string | null }>(
        `SELECT id, owner_user_id FROM agents WHERE id = $1 AND space_id = $2 LIMIT 1`,
        [agentId, identity.spaceId],
      );
      const owner = agent.rows[0];
      if (!owner) return reply.code(404).send({ detail: "Agent not found in this space" });
      if (owner.owner_user_id && owner.owner_user_id !== identity.userId) {
        return reply.code(403).send({ detail: "Only the Agent's owner can clear its host state" });
      }
      const host = await pool.query<{ id: string }>(
        `SELECT id FROM hosts WHERE id = $1 AND owner_user_id = $2 AND status <> 'revoked' LIMIT 1`,
        [hostId, identity.userId],
      );
      if (!host.rows[0]) return reply.code(404).send({ detail: "Host not found" });
      // The whole reset runs inside one transaction that locks this Agent's
      // threads on this host. A read-then-act check would miss a dispatch that
      // claims its lock a millisecond later, and the daemon would then rename
      // the profile directory out from under a launching run. Holding the rows
      // is also what makes the archive and the session retirement one
      // decision: `claimConversationDispatch` blocks on them until this
      // returns.
      const outcome = await withTransaction(pool, async (client) => {
        const threads = await client.query<{ id: string; dispatch_lock_id: string | null; run_in_flight: boolean }>(
          `SELECT thread.id, thread.dispatch_lock_id,
                  -- A Task or Automation thread never claims the dispatch
                  -- lock; its admission serialises on the latest Run's status
                  -- instead. Without asking that here, a reset would archive
                  -- the profile under a Run still writing into it, and the
                  -- Run's outcome would then re-arm the thread with a session
                  -- whose store is gone.
                  EXISTS (
                    SELECT 1 FROM runs r
                     WHERE r.host_task_thread_id = thread.id
                       AND r.status <> ALL($3::text[])
                  ) AS run_in_flight
             FROM host_threads thread
            WHERE thread.execution_host_id = $2
              AND thread.status IN ('active', 'session_reset')
              AND (
                thread.agent_id = $1
                OR (thread.agent_id IS NULL AND (
                  SELECT r.agent_id FROM runs r
                   WHERE r.host_task_thread_id = thread.id
                   ORDER BY r.created_at DESC LIMIT 1
                ) = $1)
              )
            FOR UPDATE OF thread`,
          [agentId, hostId, [...TERMINAL_RUN_STATUSES]],
        );
        if (threads.rows.some((thread) => thread.dispatch_lock_id)) {
          throw new ChatContextError("The Agent is handling a message; try again when it finishes", 409);
        }
        if (threads.rows.some((thread) => thread.run_in_flight)) {
          throw new ChatContextError("The Agent has a Run in flight on this Host; try again when it finishes", 409);
        }
        // Retired before the host is asked, and rolled back with it if the ask
        // fails. The two orderings fail differently and only one of them is
        // recoverable: a thread left claiming a `vendor_session_id` whose store
        // has been archived resumes into nothing, while a thread reset without
        // the archive happening simply starts a fresh session in a profile that
        // still holds the old one — wasteful, visible in the error the caller
        // gets, and fixed by running it again.
        const retired = await new PgHostThreadRepository(client).retireAgentSessionsOnHost(agentId, hostId);
        const result = await sharedHostConnectionRegistry.resetAgentHostProfiles(hostId, agentId);
        if (!result.ok) {
          throw new ChatContextError(
            result.error === "host_offline"
              ? "The execution Host is offline"
              : "The Host could not clear this Agent's profiles",
            result.error === "host_offline" ? 409 : 502,
          );
        }
        return { profiles_archived: result.changed, sessions_retired: retired };
      });
      return reply.send({ agent_id: agentId, host_id: hostId, ...outcome });
    } catch (error) {
      if (error instanceof ChatContextError) return reply.code(error.statusCode).send({ detail: error.body });
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/agents/:agentId/chat", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const agentId = params(request).agentId ?? "";
    const body = jsonBody(request);
    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!rawMessage) return reply.code(422).send({ detail: "message must not be empty" });
    if (rawMessage.length > MAX_MESSAGE_CHARS) {
      return reply.code(422).send({
        detail: `message exceeds ${MAX_MESSAGE_CHARS} characters`,
      });
    }

    try {
      const req = protocol.ChatTurnRequestSchema.parse({
        ...body,
        message: rawMessage,
      });
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: req.project_id,
      });
      const services = agentChatServices(context);
      const agent = await services.agents.getAgentForChat(
        creation.spaceId,
        identity.userId,
        agentId,
      );
      if (!agent) {
        return reply
          .code(404)
          .send({ detail: `Agent '${agentId}' not found in this space` });
      }
      if (!agent.current_version_id) {
        return reply
          .code(400)
          .send({ detail: `Agent '${agentId}' has no current version` });
      }

      const accepted = await services.inTransaction(async (transaction) => {
        const session = req.session_id
          ? await transaction.sessions.getSession(
              creation.spaceId,
              identity.userId,
              req.session_id,
            )
          : await transaction.sessions.createSession(
              creation.spaceId,
              identity.userId,
              {
                title: `${agent.name || "Assistant"} chat`,
                projectId: req.project_id,
              },
            );
        if (!session) {
          throw new ChatContextError("session not found in this space", 404);
        }
        if ((session.project_id ?? null) !== (req.project_id ?? null)) {
          throw new ChatContextError(
            "session belongs to a different Project context",
            409,
          );
        }
        const backend = await transaction.backends.resolveBinding({
          space_id: creation.spaceId,
          user_id: identity.userId,
          session_id: session.id,
          agent_id: agent.id,
          requested: req.backend ?? null,
        });
        const sessionConfig = validateConversationSessionConfig(
          req.session_config ?? [],
          backend.session_config_options ?? [],
        );
        const hostDispatch = backend.execution_host_id
          ? await (transaction.db
            ? prepareHostConversationDispatch({
              db: transaction.db,
              backend,
              container: { kind: "direct", user_id: identity.userId },
              sessionId: session.id,
              spaceId: creation.spaceId,
              projectId: req.project_id ?? null,
              agentId: agent.id,
              userId: identity.userId,
            })
            : Promise.reject(new ChatContextError("Host-bound chat is temporarily unavailable", 503)))
          : null;
        // Not gated on a managed workspace: a direct chat pinned to a
        // registered Location has no Rainver-managed cwd, but the Agent's
        // runtime profile was archived when the session was deleted and is
        // what this brings back.
        if (req.restore_workspace && hostDispatch) {
          const restored = await sharedHostConnectionRegistry.requestManagedWorkspaceAction(
            backend.execution_host_id!,
            "managed_workspace_restore",
            {
              agent_id: agent.id,
              container_kind: "direct",
              container_id: identity.userId,
              // A direct chat has one Agent, so whatever was archived comes
              // back together — but only a managed container had a cwd to
              // archive, which is the same condition its archive used.
              include_workspace: hostDispatch.workspace.kind === "managed",
            },
          );
          if (!restored.ok) {
            throw new ChatContextError(
              restored.error === "host_offline"
                ? "The execution Host is offline"
                : "The managed workspace could not be restored",
              restored.error === "host_offline" ? 503 : 409,
            );
          }
          if (!restored.changed) {
            throw new ChatContextError("No archived managed workspace is available to restore", 409);
          }
        }
        await transaction.runtimeSessions.claimTurn({
          space_id: creation.spaceId,
          session_id: session.id,
          user_id: identity.userId,
        });

        const userMessage = await transaction.sessions.addMessage(
          creation.spaceId,
          identity.userId,
          session.id,
          { role: "user", content: rawMessage },
        );
        if (!userMessage) {
          throw new ChatContextError("session not found in this space", 404);
        }

        const history = hostDispatch && transaction.sessions.listMessages
          ? (await transaction.sessions.listMessages(
              creation.spaceId,
              identity.userId,
              session.id,
              40,
              0,
            )) ?? []
          : [];

        const prepared = await prepareChatRun(transaction, {
          agentId: agent.id,
          agentVersionId: agent.current_version_id!,
          spaceId: creation.spaceId,
          userId: identity.userId,
          sessionId: session.id,
          message: rawMessage,
          currentMessage: userMessage,
          projectId: req.project_id,
          visibility: creation.visibility,
          backend,
          sessionConfig,
          hostDispatch,
          hostPromptContext: hostDispatch
            ? [
              // The same identity block the Room turn sends: role, then what
              // the Agent has become, then what it learned where the audience
              // already reached — which in a direct chat is this one person.
              // `transaction.db` is non-null wherever `hostDispatch` is: the
              // branch that builds one rejects with a 503 without it.
              await renderAgentIdentityPrompt(transaction.db!, {
                spaceId: creation.spaceId,
                agentId: agent.id,
                roomId: null,
                directUserId: identity.userId,
              }),
              renderDirectHostPrompt(history, userMessage.id),
            ].filter(Boolean).join("\n\n") || null
            : null,
        });
        const linked = await transaction.sessions.attachRunToUserMessage({
          space_id: creation.spaceId,
          user_id: identity.userId,
          session_id: session.id,
          message_id: userMessage.id,
          run_id: prepared.run_id,
        });
        if (!linked) {
          throw new ChatContextError(
            "The chat turn could not retain its Run recovery reference",
            500,
          );
        }

        if (hostDispatch && transaction.hostThreads) {
          await transaction.hostThreads.recordDirectDispatch(hostDispatch.host_thread.id, {
            lastRunId: prepared.run_id,
            sessionId: session.id,
            dispatchLockId: hostDispatch.dispatch_lock_id,
          });
        }

        try {
          await transaction.jobs.enqueue({
            run_id: prepared.run_id,
            space_id: creation.spaceId,
            user_id: identity.userId,
            agent_id: agent.id,
          });
        } catch {
          throw new ChatContextError(
            "The chat turn could not be queued",
            503,
          );
        }
        return {
          sessionId: session.id,
          runId: prepared.run_id,
          userMessageId: userMessage.id,
          backend: publicConversationBackend(backend),
          retiredRuntimeStateKeys: prepared.retired_runtime_state_keys,
        };
      });
      await Promise.allSettled(
        accepted.retiredRuntimeStateKeys.map((stateKey) =>
          removeConversationRuntimeState({
            rainver_home: context.config.rainverHome,
            sandbox_root: context.config.sandboxRoot,
            state_key: stateKey,
          })
        ),
      );
      return reply.code(202).send(
        protocol.ChatTurnAcceptedSchema.parse({
          schema_version: "chat_turn_accepted.v1",
          session_id: accepted.sessionId,
          run_id: accepted.runId,
          user_message_id: accepted.userMessageId,
          status: "queued",
          event_stream_url:
            `/api/v1/runs/${encodeURIComponent(accepted.runId)}/turn/stream`,
          backend: accepted.backend,
        }),
      );
    } catch (error) {
      if (error instanceof ChatContextError) {
        return reply.code(error.statusCode).send({ detail: error.body });
      }
      if (error instanceof ConversationBackendError) {
        return reply.code(error.statusCode).send({ detail: error.message });
      }
      if (error instanceof ConversationTurnInProgressError) {
        return reply.code(error.statusCode).send({ detail: error.message });
      }
      if (error instanceof RunCreateValidationError) {
        return reply.code(error.statusCode).send({ detail: error.message });
      }
      return sendDomainError(reply, error);
    }
  });
}

function rejectRuntimeProfileCredential(body: Record<string, unknown>): void {
  const config = optionalRecordBody(body, "runtime_config_json") ?? {};
  // Refused rather than ignored: writing a runtime profile takes only read
  // access to the Agent for an ordinary Agent, so a privilege set from here
  // would be one any member could grant themselves. Saying so beats accepting
  // the key and quietly not honouring it.
  if (Object.hasOwn(body, "egress_profile") || Object.hasOwn(config, "egress_install")) {
    throw new RunCreateValidationError(
      "Package-install egress is granted per Run by the dispatcher, not on an Agent runtime profile",
      422,
    );
  }
  if (
    Object.hasOwn(body, "credential_profile_id") ||
    Object.hasOwn(config, "credential_profile_id")
  ) {
    throw new RunCreateValidationError(
      "Rainver brokers no CLI credential: a CLI Agent names an execution host and an installation on it",
      422,
    );
  }
}

/**
 * Resolve the queued run for a chat turn.
 *
 * Chat turn creation persists only canonical user input and routing metadata.
 * Runtime Context acquisition, planning, rendering, and snapshot persistence
 * happen exactly once later in Run orchestration through the Gateway.
 */
async function prepareChatRun(
  services: AgentChatUnitOfWork,
  input: {
    agentId: string;
    agentVersionId: string;
    spaceId: string;
    userId: string;
    sessionId: string;
    message: string;
    currentMessage: MessageOut;
    projectId?: string | null;
    visibility: "private" | "space_shared" | "selected_users";
    backend: ResolvedConversationBackend;
    sessionConfig: NonNullable<protocol.ChatTurnRequest["session_config"]>;
    hostDispatch?: PreparedHostConversationDispatch | null;
    hostPromptContext?: string | null;
  },
): Promise<PreparedChatRun> {
  const lightweightCliConversation =
    isLocalCliRuntimeAdapter(input.backend.adapter_type) &&
    !input.projectId;
  const created = await services.runs.createQueuedRun({
    agent_id: input.agentId,
    space_id: input.spaceId,
    user_id: input.userId,
    mode: "live",
    run_type: "agent",
    trigger_origin: "manual",
    runtime_profile_id: input.backend.runtime_profile_id,
    runtime_profile_selection_source: "explicit",
    session_id: input.sessionId,
    project_folder_id: input.hostDispatch?.project_folder_id ?? null,
    workspace_location_id: input.hostDispatch?.host_thread.workspace_location_id ?? null,
    host_task_thread_id: input.hostDispatch?.host_thread.id ?? null,
    project_id: input.projectId ?? null,
    visibility: input.visibility,
    // The same allowance a Room message or a delegation gets in this Project;
    // this used to be a private three-action list from before scenario
    // allowances existed, so a direct chat could not do what a Room could.
    ...conversationToolGrantInput({ project_id: input.projectId ?? null }),
    prompt: input.hostPromptContext
      ? `${input.hostPromptContext}\n\n[Assigned direct-chat message]\n${input.message}`
      : input.message,
    model_override_json: {
      conversation_backend: {
        schema_version: "conversation_backend.v1",
        ...publicConversationBackend(input.backend),
      },
      ...(lightweightCliConversation
        ? { execution_mode: "conversation_lightweight.v1" }
        : {}),
      ...(input.sessionConfig.length ? { acp_session_config: input.sessionConfig } : {}),
      chat_turn: {
        schema_version: "chat_turn.v1",
        // What this turn was asked, kept apart from the assembled prompt for
        // the same reason a Room turn keeps it apart: the prompt also carries
        // this Agent's own persona and notes, which are nobody else's to read.
        assigned_task: input.message,
        session_id: input.sessionId,
        user_id: input.userId,
        user_message_id: input.currentMessage.id,
        agent_id: input.agentId,
        agent_version_id: input.agentVersionId,
        project_id: input.projectId ?? null,
      },
      ...(input.hostDispatch
        ? {
            workspace: input.hostDispatch.workspace,
            host_thread: {
              schema_version: "host_thread.v1",
              thread_id: input.hostDispatch.host_thread.id,
              runtime_session_id: input.hostDispatch.host_resume_attempted
                ? input.hostDispatch.host_thread.vendor_session_id
                : null,
              fresh: input.hostDispatch.host_prompt_fresh,
            },
          }
        : {}),
    },
  });

  return {
    run_id: created.id,
    retired_runtime_state_keys: Array.from(
      new Set([
        input.backend.retired_runtime_state_key,
      ].filter((stateKey): stateKey is string => Boolean(stateKey))),
    ),
    ...(input.hostDispatch ? { host_thread_id: input.hostDispatch.host_thread.id } : {}),
  };
}

function validateConversationSessionConfig(
  requested: NonNullable<protocol.ChatTurnRequest["session_config"]>,
  advertised: NonNullable<ResolvedConversationBackend["session_config_options"]>,
): NonNullable<protocol.ChatTurnRequest["session_config"]> {
  const seen = new Set<string>();
  return requested.map((selection) => {
    if (seen.has(selection.id)) throw new ChatContextError(`Session option '${selection.id}' was selected more than once`, 422);
    seen.add(selection.id);
    const option = advertised.find((candidate) => candidate.id === selection.id);
    if (!option || option.type !== selection.type || option.category !== selection.category) {
      throw new ChatContextError(`Session option '${selection.id}' is not available for this backend`, 422);
    }
    if (option.type === "select") {
      if (typeof selection.value !== "string" || !option.options.some((choice) => choice.value === selection.value)) {
        throw new ChatContextError(`Value for session option '${selection.id}' is not available`, 422);
      }
    } else if (typeof selection.value !== "boolean") {
      throw new ChatContextError(`Value for session option '${selection.id}' must be boolean`, 422);
    }
    return selection;
  });
}

async function latestConversationSessionConfig(
  db: Pool,
  spaceId: string,
  sessionId: string,
  agentId: string,
): Promise<NonNullable<protocol.ConversationBackendCatalog["session_config"]>> {
  const result = await db.query<{ config: unknown }>(
    `SELECT model_override_json->'acp_session_config' AS config
       FROM runs
      WHERE space_id = $1 AND session_id = $2 AND agent_id = $3
        AND model_override_json ? 'acp_session_config'
      ORDER BY created_at DESC
      LIMIT 1`,
    [spaceId, sessionId, agentId],
  );
  const parsed = protocol.ConversationBackendCatalogSchema.shape.session_config.safeParse(result.rows[0]?.config);
  return parsed.success ? parsed.data ?? [] : [];
}

function agentChatServices(context: ModuleContext): AgentChatServices {
  if (servicesFactoryOverride) return servicesFactoryOverride(context);
  const pool = dbPool(context.config);
  return {
    agents: PgAgentChatRepository.fromConfig(context.config),
    ...agentChatUnitOfWork(pool),
    inTransaction: (work) => withTransaction(pool, (client) => work(agentChatUnitOfWork(client))),
  };
}

function agentChatUnitOfWork(db: Pool | PoolClient): AgentChatUnitOfWork {
  const jobs = new PgJobQueueRepository(db);
  return {
    db,
    sessions: new PgSessionRepository(db),
    backends: new PgConversationBackendRepository(db),
    runtimeSessions: new PgConversationRuntimeSessionRepository(db),
    runs: new PgRunRepository(db),
    hostThreads: new PgHostThreadRepository(db),
    jobs: {
      enqueue: async (input) => {
        await jobs.enqueue({
          job_type: "agent_run",
          space_id: input.space_id,
          user_id: input.user_id,
          agent_id: input.agent_id,
          payload: {
            run_id: input.run_id,
            agent_id: input.agent_id,
          },
        });
      },
    },
  };
}

function publicConversationBackend(
  backend: ResolvedConversationBackend,
): { runtime_profile_id: string; adapter_type: string } {
  return {
    runtime_profile_id: backend.runtime_profile_id,
    adapter_type: backend.adapter_type,
  };
}

function renderDirectHostPrompt(messages: MessageOut[], currentMessageId: string): string | null {
  const lines = messages
    .filter((message) => message.id !== currentMessageId)
    .slice(-40)
    .map((message) => {
      const speaker = message.role === "assistant"
        ? "Agent"
        : message.role === "system" ? "Rainver" : "User";
      return `${speaker}: ${message.content}`;
    });
  return lines.length > 0 ? ["[Recent direct-chat history]", ...lines].join("\n") : null;
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AgentChatIdentity | null> {
  if (identityOverride) {
    return typeof identityOverride === "function"
      ? identityOverride(request)
      : identityOverride;
  }
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(context.config, request);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    reply.code(identity.statusCode);
    reply.header("content-type", "application/json");
    reply.send(identity.body);
    return null;
  }
  await sendErrorEnvelope(
    reply,
    502,
    errorEnvelope(
      identity.reason === "contract_violation"
        ? "introspect_contract_violation"
        : "identity_unavailable",
      "Identity introspection failed",
      requestId,
    ),
  );
  return null;
}
