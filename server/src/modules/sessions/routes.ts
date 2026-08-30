import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { PgSessionRepository } from "./repository.js";
import { withTransaction } from "../../db/tx.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import { sharedHostConnectionRegistry } from "../hosts/connectionRegistry.js";
import { dbPool, sendRouteError } from "../routeUtils/common.js";
import { resolveContentCreationContext } from "../access/creationContext.js";

interface SessionServices {
  repository: Pick<
    PgSessionRepository,
    | "listSessions"
    | "getSession"
    | "listMessages"
    | "createSession"
    | "addMessage"
    | "reflectSession"
  >;
}

type SessionServicesFactory = (context: ModuleContext) => SessionServices;
type SessionIdentity = { spaceId: string; userId: string };
type SessionIdentityOverride =
  | SessionIdentity
  | ((request: FastifyRequest) => Promise<SessionIdentity | null> | SessionIdentity | null);

let servicesFactoryOverride: SessionServicesFactory | null = null;
let identityOverride: SessionIdentityOverride | null = null;

export function __setSessionServicesFactoryForTests(
  factory: SessionServicesFactory | null,
): void {
  servicesFactoryOverride = factory;
}

export function __setSessionIdentityForTests(
  identity: SessionIdentityOverride | null,
): void {
  identityOverride = identity;
}

function sessionServices(context: ModuleContext): SessionServices {
  if (servicesFactoryOverride) return servicesFactoryOverride(context);
  return { repository: PgSessionRepository.fromConfig(context.config) };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/sessions", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const parsed = parsePage(request, { limit: 50, maxLimit: 200 });
    if ("error" in parsed) return reply.code(422).send({ detail: parsed.error });
    const services = sessionServices(context);
    const page = await services.repository.listSessions(
      identity.spaceId,
      identity.userId,
      parsed.limit,
      parsed.offset,
    );
    return reply.send(page);
  });

  app.get("/api/v1/sessions/:sessionId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const sessionId = params(request).sessionId ?? "";
    const services = sessionServices(context);
    const session = await services.repository.getSession(
      identity.spaceId,
      identity.userId,
      sessionId,
    );
    if (!session) return reply.code(404).send({ detail: "Session not found" });
    return reply.send(session);
  });

  app.get("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const sessionId = params(request).sessionId ?? "";
    const parsed = parsePage(request, { limit: 100, maxLimit: 500 });
    if ("error" in parsed) return reply.code(422).send({ detail: parsed.error });
    const services = sessionServices(context);
    const messages = await services.repository.listMessages(
      identity.spaceId,
      identity.userId,
      sessionId,
      parsed.limit,
      parsed.offset,
    );
    if (messages === null) return reply.code(404).send({ detail: "Session not found" });
    return reply.send(messages);
  });

  app.delete("/api/v1/sessions/:sessionId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const sessionId = params(request).sessionId ?? "";
    try {
      const deleted = await withTransaction(dbPool(context.config), async (client) => {
        const session = await client.query<{ id: string }>(
          `SELECT s.id
             FROM sessions s
            WHERE s.id = $1
              AND s.space_id = $2
              AND s.user_id = $3
              AND s.room_id IS NULL
              AND s.status = 'active'
            FOR UPDATE`,
          [sessionId, identity.spaceId, identity.userId],
        );
        if (!session.rows[0]) return null;

        const directThreads = await client.query<{
          id: string;
          agent_id: string;
          execution_host_id: string | null;
          workspace_mode: "location" | "managed";
        }>(
          `SELECT thread.id, thread.agent_id, thread.execution_host_id, thread.workspace_mode
             FROM session_conversation_backends binding
             JOIN host_threads thread
               ON thread.agent_id = binding.agent_id
              AND thread.container_kind = 'direct'
              AND thread.container_user_id = binding.user_id
              AND thread.room_id IS NULL
              AND thread.status IN ('active', 'session_reset')
            WHERE binding.space_id = $1
              AND binding.session_id = $2
              AND binding.user_id = $3
            FOR UPDATE OF thread`,
          [identity.spaceId, sessionId, identity.userId],
        );

        await client.query(
          `UPDATE sessions SET status = 'archived', updated_at = now()
            WHERE id = $1 AND space_id = $2 AND user_id = $3`,
          [sessionId, identity.spaceId, identity.userId],
        );

        const threadRepository = new PgHostThreadRepository(client);
        for (const thread of directThreads.rows) {
          await threadRepository.closeDirectAgent(thread.agent_id, identity.userId, thread.workspace_mode === "managed");
        }
        return directThreads.rows
          .filter((thread) => thread.workspace_mode === "managed" && thread.execution_host_id)
          .map((thread) => ({
            threadId: thread.id,
            hostId: thread.execution_host_id!,
            agentId: thread.agent_id,
          }));
      });
      if (!deleted) return reply.code(404).send({ detail: "Session not found" });

      const archived = [];
      for (const target of deleted) {
        const result = await sharedHostConnectionRegistry.requestManagedWorkspaceAction(
          target.hostId,
          "managed_workspace_archive",
          { agent_id: target.agentId, container_kind: "direct", container_id: identity.userId },
        );
        archived.push({ agent_id: target.agentId, ...result });
        if (result.ok) {
          await new PgHostThreadRepository(dbPool(context.config))
            .acknowledgeManagedWorkspaceArchive(target.threadId)
            .catch(() => undefined);
        }
      }
      return reply.send({ deleted: true, session_id: sessionId, managed_workspace_archive: archived });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sessions", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const body = jsonBody(request);
    try {
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      const services = sessionServices(context);
      const session = await services.repository.createSession(
        creation.spaceId,
        identity.userId,
        {
          projectFolderId: creation.projectId ? optionalString(body.project_folder_id) : null,
          projectId: creation.projectId,
          title: optionalString(body.title),
          metadata: optionalRecord(body.metadata),
        },
      );
      return reply.code(201).send(session);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const sessionId = params(request).sessionId ?? "";
    const body = jsonBody(request);
    const parsed = protocol.MessageCreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: "content is required and no other fields are accepted" });
    }
    const services = sessionServices(context);
    const message = await services.repository.addMessage(
      identity.spaceId,
      identity.userId,
      sessionId,
      { role: "user", content: parsed.data.content },
    );
    if (message === null) return reply.code(404).send({ detail: "Session not found" });
    return reply.code(201).send(message);
  });

  app.post("/api/v1/sessions/:sessionId/reflect", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const sessionId = params(request).sessionId ?? "";
    const services = sessionServices(context);
    const result = await services.repository.reflectSession(
      identity.spaceId,
      identity.userId,
      sessionId,
    );
    if (!result) return reply.code(404).send({ detail: "Session not found" });
    return reply.send(result);
  });
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionIdentity | null> {
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

function parsePage(
  request: FastifyRequest,
  opts: { limit: number; maxLimit: number },
): { limit: number; offset: number } | { error: string } {
  const q = query(request);
  const limit = intQuery(q.limit, opts.limit);
  const offset = intQuery(q.offset, 0);
  if (limit === null || limit < 0 || limit > opts.maxLimit) {
    return { error: `limit must be between 0 and ${opts.maxLimit}` };
  }
  if (offset === null || offset < 0) return { error: "offset must be non-negative" };
  return { limit, offset };
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const text = request.body instanceof Buffer ? request.body.toString("utf8") : "";
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function intQuery(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
