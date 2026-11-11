import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { PgSessionRepository } from "./repository.js";
import { dbPool, sendRouteError } from "../routeUtils/common.js";
import { ConversationExecutionContextService } from "./executionContextService.js";
import { ConversationInputError, ConversationInputService } from "./conversationInputService.js";

interface SessionServices {
  repository: Pick<
    PgSessionRepository,
    | "listSessions"
    | "getSession"
    | "listMessages"
  >;
}

type SessionServicesFactory = (context: ModuleContext) => SessionServices;
type ExecutionContextService = Pick<
  ConversationExecutionContextService,
  "preview"
>;
type ExecutionContextServiceFactory = (context: ModuleContext) => ExecutionContextService;
type SessionIdentity = { spaceId: string; userId: string };
type SessionIdentityOverride =
  | SessionIdentity
  | ((request: FastifyRequest) => Promise<SessionIdentity | null> | SessionIdentity | null);

let servicesFactoryOverride: SessionServicesFactory | null = null;
let executionContextServiceFactoryOverride: ExecutionContextServiceFactory | null = null;
let identityOverride: SessionIdentityOverride | null = null;

export function __setSessionServicesFactoryForTests(
  factory: SessionServicesFactory | null,
): void {
  servicesFactoryOverride = factory;
}

export function __setExecutionContextServiceFactoryForTests(
  factory: ExecutionContextServiceFactory | null,
): void {
  executionContextServiceFactoryOverride = factory;
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

function executionContextService(context: ModuleContext): ExecutionContextService {
  if (executionContextServiceFactoryOverride) return executionContextServiceFactoryOverride(context);
  return new ConversationExecutionContextService(dbPool(context.config));
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const session = { sessionId: "session_id" };
  registerOperationAdapters(app, context.config, [
    { method: "POST", url: "/api/v1/sessions", operation: "session.create" },
    { method: "DELETE", url: "/api/v1/sessions/:sessionId", operation: "session.delete", params: session },
    { method: "POST", url: "/api/v1/sessions/:sessionId/messages", operation: "session.message.add", params: session },
    { method: "POST", url: "/api/v1/sessions/:sessionId/reflect", operation: "session.reflect", params: session },
    { method: "POST", url: "/api/v1/sessions/:sessionId/execution-context/initialize", operation: "conversation.execution.initialize", params: session },
    { method: "POST", url: "/api/v1/sessions/:sessionId/execution-context/attachments", operation: "conversation.execution.attachment.mutate", params: session },
    // A read-only query kept at its historical POST URL; it changes nothing.
    { method: "POST", url: "/api/v1/sessions/:sessionId/execution-context/preflight", operation: "conversation.execution.preflight", params: session },
  ]);
  app.post("/api/v1/conversation-inputs/media", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const file = await request.file();
      if (!file) return reply.code(422).send({ detail: "an image file is required" });
      const media = await new ConversationInputService(dbPool(context.config), context.config).uploadImage({
        spaceId: identity.spaceId,
        userId: identity.userId,
        filename: file.filename,
        mediaType: file.mimetype,
        stream: file.file,
      });
      return reply.code(201).send(media);
    } catch (error) {
      if (error instanceof ConversationInputError) return reply.code(error.statusCode).send({ detail: error.message });
      // @fastify/multipart marks a stream when its configured byte limit fires.
      if (error instanceof Error && /Request file too large|part exceeds the file size limit/i.test(error.message)) {
        return reply.code(413).send({ detail: "image exceeds the upload limit" });
      }
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/conversation-inputs/media/:mediaId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const mediaId = params(request).mediaId ?? "";
    try {
      const service = new ConversationInputService(dbPool(context.config), context.config);
      const media = await service.getVisibleMedia(identity.spaceId, identity.userId, mediaId);
      if (!media) return reply.code(404).send({ detail: "conversation media not found" });
      const body = await service.readMedia(media);
      reply.header("content-type", media.media_type);
      reply.header("content-length", String(body.byteLength));
      reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`);
      reply.header("x-content-type-options", "nosniff");
      return reply.send(body);
    } catch (error) {
      if (error instanceof ConversationInputError) return reply.code(error.statusCode).send({ detail: error.message });
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/conversation-inputs/media/:mediaId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const mediaId = params(request).mediaId ?? "";
    try {
      const deleted = await new ConversationInputService(dbPool(context.config), context.config)
        .deletePendingMedia(identity.spaceId, identity.userId, mediaId);
      if (!deleted) return reply.code(404).send({ detail: "pending conversation media not found" });
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

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

  app.get("/api/v1/sessions/:sessionId/input-files", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const q = query(request);
    const limit = intQuery(q.limit, 20);
    if (limit === null || limit < 1 || limit > 20) return reply.code(422).send({ detail: "limit must be between 1 and 20" });
    const search = q.q ?? "";
    if (search.length > 200) return reply.code(422).send({ detail: "q must be at most 200 characters" });
    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    request.raw.once("close", onClose);
    try {
      const result = await new ConversationInputService(dbPool(context.config), context.config).searchFiles({
        spaceId: identity.spaceId,
        userId: identity.userId,
        sessionId: params(request).sessionId ?? "",
        query: search,
        limit,
        signal: abortController.signal,
      });
      return reply.send(result);
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (error instanceof ConversationInputError) return reply.code(error.statusCode).send({ detail: error.message });
      return sendRouteError(reply, error);
    } finally {
      request.raw.off("close", onClose);
    }
  });

  app.get("/api/v1/sessions/:sessionId/execution-context", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      // A read: no draft row or Host row is written to answer it.
      const summary = await executionContextService(context).preview(
        identity,
        params(request).sessionId ?? "",
        { selection: null, runtime: null },
      );
      return reply.send(summary);
    } catch (error) {
      return sendRouteError(reply, error);
    }
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



function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function intQuery(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
