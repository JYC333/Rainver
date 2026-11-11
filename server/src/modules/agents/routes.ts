import { registerOperationAdapters, type OperationAdapterRoute } from "../systemActions/operations/routeAdapter.js";
import { conversationModelSwitchAllowed } from "../sessions/conversationQuotaPolicy.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { PgConversationBackendRepository } from "../sessions/conversationBackendRepository.js";
import { PgRunRepository } from "../runs/repository.js";
import { runToOut } from "../runs/runReadModel.js";
import { resolveRunRemoteness } from "../runs/runRemoteness.js";
import {
  dbPool,
  parsePage,
  query as routeQuery,
  sendRouteError,
} from "../routeUtils/common.js";
import { PgProposalRepository } from "../proposals/repository.js";
import { PgAgentChatRepository, PgAgentRepository } from "./repository.js";
import { assertProjectReadable } from "../projects/access.js";
import {
  params,
  stringValue,
} from "./agentRouteInputs.js";

type AgentChatIdentity = { spaceId: string; userId: string };
type AgentChatIdentityOverride =
  | AgentChatIdentity
  | ((request: FastifyRequest) => Promise<AgentChatIdentity | null> | AgentChatIdentity | null);

let identityOverride: AgentChatIdentityOverride | null = null;

export function __setAgentChatIdentityForTests(
  identity: AgentChatIdentityOverride | null,
): void {
  identityOverride = identity;
}

/** Retained Agent URLs; each is a formal adapter for one core operation. */
export const AGENT_OPERATION_ROUTES: readonly OperationAdapterRoute[] = [
  { method: "POST", url: "/api/v1/agents", operation: "agent.create" },
  { method: "PUT", url: "/api/v1/agents/runtime-default", operation: "agent.runtime_default.set" },
  { method: "PATCH", url: "/api/v1/agents/default-assistant/settings", operation: "agent.assistant_settings.update", query: { project_id: "project_id" } },
  { method: "PATCH", url: "/api/v1/agents/:agentId", operation: "agent.update", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/config", operation: "agent.config.update", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/runtime-profiles", operation: "agent.runtime_profile.create", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/runtime-profiles/resolve-host-target", operation: "agent.runtime_profile.ensure_host", params: { agentId: "agent_id" } },
  { method: "PATCH", url: "/api/v1/agents/:agentId/runtime-profiles/:profileId", operation: "agent.runtime_profile.update", params: { agentId: "agent_id", profileId: "profile_id" } },
  { method: "PUT", url: "/api/v1/agents/:agentId/conversation-session-config", operation: "conversation.session_config.save", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/versions/:versionId/restore", operation: "agent.version.restore", params: { agentId: "agent_id", versionId: "version_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/runs", operation: "agent.run.create", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/run", operation: "agent.run.create", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/chat/reset-context", operation: "agent.chat.reset_context", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/chat", operation: "agent.chat.send", params: { agentId: "agent_id" } },
  { method: "POST", url: "/api/v1/agents/:agentId/chat/retry", operation: "agent.chat.retry", params: { agentId: "agent_id" } },
];

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
      if (run.execution_kind !== "agent") {
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
        identity.userId,
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


  app.get("/api/v1/agents/runtime-default", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const value = await agentRepository().getSpaceAgentRuntimeDefault(identity.spaceId);
      return reply.send(value ? protocol.SpaceAgentRuntimeDefaultOutSchema.parse(value) : null);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  // A managed Assistant's soft settings. `?project_id=` names a Project's
  // Assistant; without it, the Space's own. The read answers whether the
  // caller may change them (`can_configure`); the write enforces it: the
  // personal Space's Assistant is its person's, a shared Space's is its
  // creator's, a Project's is its owner's (`canConfigureAssistant`).
  app.get("/api/v1/agents/default-assistant/settings", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const repository = agentRepository();
      const target = assistantSettingsTarget(identity, request);
      await repository.assertAssistantSettingsReadable(identity, target);
      return reply.send({
        ...await repository.getAssistantSettings(target),
        can_configure: await repository.canConfigureAssistantSettings(identity, target),
      });
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
        ? repository.sessionConfig(identity.spaceId, sessionId, agentId)
        : Promise.resolve([]),
    ]);
    const allowSwitch = sessionId && binding ? await conversationModelSwitchAllowed(dbPool(context.config),
      identity.spaceId, sessionId, agentId, identity.userId, binding.runtime_profile_id, binding.runtime_key) : false;
    return reply.send({ options, binding, session_config: sessionConfig, allow_quota_model_switch: allowSwitch });
  });


  app.get("/api/v1/agents/:agentId/current-version", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const version = await agentRepository().getCurrentVersion(
        identity.spaceId,
        identity.userId,
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
        identity.userId,
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
        identity.userId,
        p.agentId ?? "",
        p.versionId ?? "",
      );
      return reply.send(version);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  registerOperationAdapters(app, context.config, AGENT_OPERATION_ROUTES);




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
  const identity = await introspectIdentity(context.config, request, reply);
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

/** The Assistant a settings request is about, from its explicit `project_id` query. */
function assistantSettingsTarget(
  identity: { spaceId: string },
  request: FastifyRequest,
): { spaceId: string; projectId: string | null } {
  const raw = (request.query as Record<string, unknown> | undefined)?.project_id;
  const projectId = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  return { spaceId: identity.spaceId, projectId };
}
