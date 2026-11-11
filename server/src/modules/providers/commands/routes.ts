import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stateChangingReadAllowed } from "../../../gateway/csrfOrigin.js";
import * as protocol from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { errorEnvelope, sendErrorEnvelope } from "../../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../../gateway/requestContext.js";
import { introspectIdentity } from "../../auth/identity.js";
import { registerOperationAdapters, type OperationAdapterRoute } from "../../systemActions/operations/routeAdapter.js";
import { resolveProviderCommandStore } from "./store.js";
import { ProviderCommandForbiddenError } from "./store.js";
import { listProviderModels } from "../invocation/invocation.js";
import { getDbPool } from "../db.js";
import {
  createManagedSubscriptionLoginSession,
  loginManagedSubscription,
  parseManagedSubscriptionType,
  type ManagedSubscriptionLoginSession,
} from "../subscriptionOAuth.js";
import { sseResponseHeaders } from "../../../gateway/sse.js";

const provider = { configId: "provider_id" };
/**
 * The provider block's retained write URLs, each bound to one core operation
 * (`providers/operations.ts`). Bodies are the legacy request bodies; the URL's
 * ids are the operation's target fields.
 */
export const PROVIDER_OPERATION_ROUTES: readonly OperationAdapterRoute[] = [
  { method: "POST", url: "/api/v1/providers", operation: "provider.create" },
  { method: "POST", url: "/api/v1/providers/from-preset", operation: "provider.create_from_preset" },
  { method: "PATCH", url: "/api/v1/providers/:configId", operation: "provider.update", params: provider },
  { method: "DELETE", url: "/api/v1/providers/:configId", operation: "provider.delete", params: provider },
  { method: "POST", url: "/api/v1/providers/:configId/credentials", operation: "provider.credential.add", params: provider },
  { method: "DELETE", url: "/api/v1/providers/:configId/credentials/:memberId", operation: "provider.credential.remove", params: { ...provider, memberId: "member_id" } },
  { method: "PATCH", url: "/api/v1/providers/:configId/credentials/config", operation: "provider.pool_config.update", params: provider },
  { method: "PUT", url: "/api/v1/providers/:configId/grants", operation: "provider.grant.set", params: provider },
  { method: "DELETE", url: "/api/v1/providers/:configId/grants/:spaceId", operation: "provider.grant.revoke", params: { ...provider, spaceId: "target_space_id" } },
  { method: "PUT", url: "/api/v1/providers/task-policies/:task", operation: "provider.task_policy.set", params: { task: "task" } },
  { method: "DELETE", url: "/api/v1/providers/task-policies/:task", operation: "provider.task_policy.delete", params: { task: "task" } },
  { method: "PUT", url: "/api/v1/providers/subscription-quota-policy", operation: "provider.subscription_quota_policy.set" },
  { method: "DELETE", url: "/api/v1/providers/:configId/subscription", operation: "provider.subscription.disconnect", params: provider },
  { method: "POST", url: "/api/v1/providers/:configId/test", operation: "provider.test", params: provider },
  { method: "POST", url: "/api/v1/providers/:configId/plan-usage", operation: "provider.plan_usage.refresh", params: provider },
  { method: "POST", url: "/api/v1/providers/:configId/subscription/quota", operation: "provider.subscription.quota.refresh", params: provider },
];

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function bodyText(request: FastifyRequest): string {
  return request.body instanceof Buffer ? request.body.toString("utf8") : "";
}

function jsonBody(request: FastifyRequest): unknown {
  const text = bodyText(request);
  return text ? JSON.parse(text) : {};
}

async function resolveIdentity(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ spaceId: string; userId: string } | null> {
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(config, request, reply);
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

function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode =
    error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : 400;
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(Number.isInteger(statusCode) ? statusCode : 400).send({ detail: message });
}

async function requireInstanceAdmin(config: ServerConfig, userId: string): Promise<void> {
  if (!config.instanceAdminEmail || !config.databaseUrl) {
    throw new ProviderCommandForbiddenError("INSTANCE_ADMIN_EMAIL is not configured");
  }
  const result = await getDbPool(config.databaseUrl).query<{ email: string | null }>(
    `SELECT email FROM users WHERE id=$1 AND status='active' LIMIT 1`,
    [userId],
  );
  const email = result.rows[0]?.email?.trim().toLowerCase() ?? null;
  if (email !== config.instanceAdminEmail.trim().toLowerCase()) {
    throw new ProviderCommandForbiddenError("Requires instance admin");
  }
}

const subscriptionLoginSessions = new Map<string, ManagedSubscriptionLoginSession>();

async function parseWith<T>(
  schemaName: string,
  value: unknown,
): Promise<T> {
  const schema = (protocol as unknown as Record<string, { parse(v: unknown): T }>)[schemaName];
  return schema.parse(value);
}

export function registerProviderCommandRoutes(
  app: FastifyInstance,
  config: ServerConfig,
): void {
  // CLI usage quota auto-refresh is not started here. It is a scheduled task
  // owned by SchedulerRegistry (see modules/scheduler/backgroundServices.ts)
  // so that shutdown, failure alerting, and liveness cover it like every other
  // recurring job.
  registerOperationAdapters(app, config, PROVIDER_OPERATION_ROUTES);

  app.get("/api/v1/providers/subscriptions/login/stream", async (request, reply) => {
    // A GET because it is a long-lived stream, but it starts a vendor login —
    // see the host login stream for why that needs the cross-site check a POST
    // would get for free.
    if (!stateChangingReadAllowed(request, config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-site request refused" });
    }
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await requireInstanceAdmin(config, identity.userId);
      const type = parseManagedSubscriptionType(query(request).type ?? "");
      const sessionKey = `${identity.userId}:${type}`;
      if (subscriptionLoginSessions.has(sessionKey)) {
        return reply.code(409).send({ detail: `A ${type} subscription login is already active` });
      }
      reply.raw.writeHead(200, sseResponseHeaders());
      const emit = (event: unknown) => {
        if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const session = createManagedSubscriptionLoginSession(type, emit);
      subscriptionLoginSessions.set(sessionKey, session);
      const close = () => session.cancel();
      reply.raw.once("close", close);
      try {
        const provider = await loginManagedSubscription(
          config,
          type,
          identity.spaceId,
          identity.userId,
          session.interaction,
        );
        emit({ type: "connected", provider });
      } catch (error) {
        // Authority lost while the login waited is the hidden answer: nothing was written.
        const withdrawn = [403, 404].includes((error as { statusCode?: number })?.statusCode ?? 0);
        emit({ type: "error", message: !withdrawn && error instanceof Error ? error.message : "Subscription login failed" });
      } finally {
        reply.raw.removeListener("close", close);
        subscriptionLoginSessions.delete(sessionKey);
        reply.raw.end();
      }
      return reply;
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  /**
   * Transport exemption (`operationRoutes.test.ts`): the instance admin's
   * keystrokes into their own in-process OAuth login. The one-time code is
   * handed to the live session and never persisted or replayed.
   */
  app.post("/api/v1/providers/subscriptions/login/input", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await requireInstanceAdmin(config, identity.userId);
      const type = parseManagedSubscriptionType(query(request).type ?? "");
      const body = await parseWith<{ input: string }>("ManagedSubscriptionLoginInputSchema", jsonBody(request));
      const session = subscriptionLoginSessions.get(`${identity.userId}:${type}`);
      if (!session?.submit(body.input)) {
        return reply.code(404).send({ detail: `No ${type} subscription login is awaiting input` });
      }
      return reply.send({ status: "sent" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/providers/:configId/models", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const value = await listProviderModels(
        resolveProviderCommandStore(config),
        identity.spaceId,
        params(request).configId ?? "",
        identity.userId,
        { kind: "person", user_id: identity.userId },
      );
      return reply.send(value);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/providers/:configId/credentials", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await resolveProviderCommandStore(config).listPool(
          identity.spaceId,
          params(request).configId ?? "",
        ),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/providers/task-policies", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    return reply.send(
      await resolveProviderCommandStore(config).listTaskPolicies(identity.spaceId),
    );
  });
}
