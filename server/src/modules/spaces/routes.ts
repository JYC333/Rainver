import type { FastifyInstance, FastifyRequest } from "fastify";
import * as protocol from "@agent-space/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import {
  authRepositoryFromConfig,
  sessionTokenFromRequest,
  type AuthFailure,
} from "../auth/identity.js";
import {
  spaceRepositoryFromConfig,
  type SpaceCreateInput,
  type InvitationCreateInput,
  type SpaceFailure,
} from "./repository.js";
import { enqueueRetrievalEmbeddingBackfill } from "../retrieval/embedding/job.js";

function isFailure(value: unknown): value is AuthFailure {
  return Boolean(value && typeof value === "object" && "statusCode" in value);
}

function isSpaceFailure(value: unknown): value is SpaceFailure {
  return Boolean(value && typeof value === "object" && "statusCode" in value);
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  if (!(request.body instanceof Buffer) || request.body.length === 0) return {};
  try {
    const parsed = JSON.parse(request.body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch { return {}; }
}

/** `oversight_mode` is creation-only; patch routes must not silently ignore it. */
function rejectsOversightModeMutation(payload: Record<string, unknown>): boolean {
  return Object.hasOwn(payload, "oversight_mode");
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function body<T extends object>(request: FastifyRequest): Partial<T> {
  if (!(request.body instanceof Buffer) || request.body.length === 0) return {};
  try {
    const parsed = JSON.parse(request.body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Partial<T>)
      : {};
  } catch {
    return {};
  }
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/spaces", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const payload = body<SpaceCreateInput>(request);
    const result = await spaces.createSpace(user.id, {
      name: typeof payload.name === "string" ? payload.name : "",
      type: payload.type,
      oversight_mode: payload.oversight_mode,
    });
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.code(201).send(result);
  });

  app.get("/api/v1/spaces/:spaceId/members", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.listMembers(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.post("/api/v1/spaces/:spaceId/invitations", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const payload = body<InvitationCreateInput>(request);
    const result = await spaces.createInvitation(user.id, params(request).spaceId ?? "", {
      email: typeof payload.email === "string" ? payload.email : "",
      role: payload.role,
    });
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.code(201).send(result);
  });

  app.post("/api/v1/invitations/:token/accept", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.acceptInvitation({
      token: params(request).token ?? "",
      userId: user.id,
      userEmail: user.email,
    });
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.get("/api/v1/spaces/:spaceId", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config);
    if (!repository) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope(
          "identity_db_unavailable",
          "Identity database is unavailable",
          requestId,
        ),
      );
    }
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const space = await repository.getSpaceForUser(user.id, params(request).spaceId ?? "");
    if (space === null) return reply.code(404).send({ detail: "Space not found" });
    if (isFailure(space)) return reply.code(space.statusCode).send({ detail: space.detail });
    return reply.send(space);
  });

  app.get("/api/v1/spaces/:spaceId/snapshot-defaults", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.getSnapshotDefaults(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.patch("/api/v1/spaces/:spaceId/snapshot-defaults", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const body = jsonBody(request);
    if (rejectsOversightModeMutation(body)) {
      return reply.code(422).send({ detail: "oversight_mode is immutable after Space creation" });
    }
    const result = await spaces.updateSnapshotDefaults(user.id, params(request).spaceId ?? "", {
      snapshot_retention_days_default: integerOrNull(body.snapshot_retention_days_default),
      snapshot_max_count_default: integerOrNull(body.snapshot_max_count_default),
    });
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.get("/api/v1/spaces/:spaceId/content-egress", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.getContentEgressSetting(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.patch("/api/v1/spaces/:spaceId/content-egress", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const enabled = jsonBody(request).member_copy_out_enabled;
    if (typeof enabled !== "boolean") {
      return reply.code(422).send({ detail: "member_copy_out_enabled must be a boolean" });
    }
    const result = await spaces.updateContentEgressSetting(user.id, params(request).spaceId ?? "", enabled);
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.get("/api/v1/spaces/:spaceId/retrieval-settings", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.getRetrievalSettings(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.patch("/api/v1/spaces/:spaceId/retrieval-settings", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    try {
      const rawPayload = jsonBody(request);
      if (rejectsOversightModeMutation(rawPayload)) {
        return reply.code(422).send({ detail: "oversight_mode is immutable after Space creation" });
      }
      const payload = protocol.SpaceRetrievalSettingsUpdateSchema.parse(rawPayload);
      const before = await spaces.getRetrievalSettings(user.id, params(request).spaceId ?? "");
      const result = await spaces.updateRetrievalSettings(
        user.id,
        params(request).spaceId ?? "",
        payload,
      );
      if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
      if (
        !isSpaceFailure(before) &&
        payload.embedding_dimensions !== undefined &&
        before.embedding_dimensions !== result.embedding_dimensions
      ) {
        await enqueueRetrievalEmbeddingBackfill(context.config, {
          spaceId: result.space_id,
          userId: user.id,
          trigger: "retrieval_embedding_dimension_update",
        });
      }
      return reply.send(result);
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        return reply.code(422).send({ detail: "Invalid retrieval settings" });
      }
      throw error;
    }
  });

}
