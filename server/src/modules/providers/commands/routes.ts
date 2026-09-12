import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stateChangingReadAllowed } from "../../../gateway/csrfOrigin.js";
import * as protocol from "@rainver/protocol";
import type { ProviderFromPresetCreateRequest } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { errorEnvelope, sendErrorEnvelope } from "../../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../../gateway/requestContext.js";
import { introspectIdentity } from "../../auth/identity.js";
import { resolveProviderCommandStore } from "./store.js";
import type {
  ModelProviderCreateInput,
  ModelProviderUpdateInput,
  ProviderPoolConfigUpdateInput,
  ProviderPoolCredentialAddInput,
  ProviderTaskChainEntry,
  RotationStrategy,
} from "./store.js";
import { ProviderCommandForbiddenError } from "./store.js";
import { ProviderCommandNotFoundError } from "./types.js";
import { resolveProvidersDbPort } from "../dbReader.js";
import {
  completeProviderChat,
  completeProviderEmbedding,
  completeProviderRerank,
  listProviderModels,
} from "../invocation/invocation.js";
import {
  enqueueRetrievalEmbeddingBackfill,
  resetRetrievalEmbeddingsForSpace,
} from "../../retrieval/embedding/job.js";
import { RETRIEVAL_EMBEDDING_TASK } from "../../retrieval/embedding/config.js";
import { createProviderFromPreset } from "./fromPreset.js";
import { getDbPool } from "../db.js";
import {
  createManagedSubscriptionLoginSession,
  disconnectManagedSubscription,
  loginManagedSubscription,
  parseManagedSubscriptionType,
  refreshManagedSubscriptionQuota,
  type ManagedSubscriptionLoginSession,
} from "../subscriptionOAuth.js";
import { requireProviderVendor } from "../vendors.js";
import { sseResponseHeaders } from "../../../gateway/sse.js";

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

function defaultRerankModelForProvider(providerType: string): string | null {
  if (providerType === "zeroentropy") return "zerank-2";
  if (providerType === "cohere") return "rerank-v4.0-pro";
  return null;
}

function configuredProviderModels(provider: { default_model?: string | null; available_models?: string[] }): string[] {
  return [provider.default_model, ...(provider.available_models ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function looksLikeEmbeddingModel(model: string): boolean {
  const value = model.toLowerCase();
  return value.startsWith("embed") || value.startsWith("zembed") || value.includes("embedding");
}

function looksLikeRerankModel(model: string): boolean {
  const value = model.toLowerCase();
  return value.startsWith("rerank") || value.startsWith("zerank") || value.includes("rerank");
}

function retrievalProviderTestScope(provider: { provider_type: string; default_model?: string | null; available_models?: string[] }): "embedding" | "rerank" | "both" {
  const models = configuredProviderModels(provider);
  const hasEmbedding = models.some(looksLikeEmbeddingModel);
  const hasRerank = models.some(looksLikeRerankModel);
  if (hasEmbedding && !hasRerank) return "embedding";
  if (hasRerank && !hasEmbedding) return "rerank";
  if (hasEmbedding && hasRerank) return "both";
  const vendor = requireProviderVendor(provider.provider_type);
  if (vendor.supportsEmbedding && vendor.supportsRerank) return "both";
  return vendor.supportsRerank ? "rerank" : "embedding";
}

function firstModelMatching(
  provider: { default_model?: string | null; available_models?: string[] },
  predicate: (model: string) => boolean,
): string | null {
  return configuredProviderModels(provider).find(predicate) ?? null;
}

async function resolveIdentity(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ spaceId: string; userId: string } | null> {
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(config, request);
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

/** The provider a connection test targets, read without resolving its key. */
async function testedProvider(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  providerId: string,
): Promise<{ id: string; provider_type: string; default_model: string | null; available_models: string[] }> {
  const provider = await resolveProvidersDbPort(config)?.getProvider(identity.spaceId, identity.userId, providerId);
  if (!provider || typeof provider !== "object") {
    throw new ProviderCommandNotFoundError(`ModelProvider '${providerId}' not found`);
  }
  const row = provider as Record<string, unknown>;
  return {
    id: String(row.id),
    provider_type: String(row.provider_type),
    default_model: typeof row.default_model === "string" ? row.default_model : null,
    available_models: Array.isArray(row.available_models)
      ? row.available_models.filter((model): model is string => typeof model === "string")
      : [],
  };
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
        emit({ type: "error", message: error instanceof Error ? error.message : "Subscription login failed" });
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

  app.post("/api/v1/providers/:configId/subscription/quota", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await requireInstanceAdmin(config, identity.userId);
      return reply.send(await refreshManagedSubscriptionQuota(
        config,
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
      ));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.delete("/api/v1/providers/:configId/subscription", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await requireInstanceAdmin(config, identity.userId);
      return reply.send(await disconnectManagedSubscription(
        config,
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
      ));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/providers", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<ModelProviderCreateInput>(
        "ModelProviderCreateRequestSchema",
        jsonBody(request),
      );
      const value = await resolveProviderCommandStore(config).createProvider(
        identity.spaceId,
        identity.userId,
        body,
      );
      return reply.code(201).send(value);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/providers/from-preset", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<ProviderFromPresetCreateRequest>(
        "ProviderFromPresetCreateRequestSchema",
        jsonBody(request),
      );
      const value = await createProviderFromPreset(
        config,
        resolveProviderCommandStore(config),
        identity.spaceId,
        identity.userId,
        body,
      );
      return reply.code(201).send(value);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.patch("/api/v1/providers/:configId", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<ModelProviderUpdateInput>(
        "ModelProviderUpdateRequestSchema",
        jsonBody(request),
      );
      const value = await resolveProviderCommandStore(config).updateProvider(
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
        body,
      );
      return reply.send(value);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.delete("/api/v1/providers/:configId", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await resolveProviderCommandStore(config).deleteProvider(
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
      );
      return reply.code(204).send();
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.put("/api/v1/providers/:configId/grants", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{
        space_id: string;
        enabled?: boolean;
        is_default?: boolean;
        network_profile_id?: string | null;
      }>("ModelProviderSpaceGrantRequestSchema", jsonBody(request));
      const value = await resolveProviderCommandStore(config).grantProviderToSpace(
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
        body,
      );
      return reply.send(value);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.delete("/api/v1/providers/:configId/grants/:spaceId", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await resolveProviderCommandStore(config).revokeProviderGrant(
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
        params(request).spaceId ?? "",
      );
      return reply.code(204).send();
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

  app.post("/api/v1/providers/:configId/test", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const store = resolveProviderCommandStore(config);
      // Read without resolving a key: each completion below decides its spend
      // before it resolves one.
      const provider = await testedProvider(config, identity, params(request).configId ?? "");
      const vendor = requireProviderVendor(provider.provider_type);
      if (!vendor.supportsChat && (vendor.supportsEmbedding || vendor.supportsRerank)) {
        const scope = retrievalProviderTestScope(provider);
        const embedding = scope === "rerank" ? null : await completeProviderEmbedding(store, identity.spaceId, {
          provider_id: provider.id,
          model: firstModelMatching(provider, looksLikeEmbeddingModel),
          inputs: ["rainver retrieval provider connection test"],
          inputType: "document",
          metering: { subject_user_id: identity.userId },
          spend: { kind: "person", user_id: identity.userId },
        });
        const rerank = scope === "embedding" ? null : await completeProviderRerank(store, identity.spaceId, {
          provider_id: provider.id,
          query: "retrieval provider test",
          documents: ["retrieval provider test document", "unrelated document"],
          topN: 1,
          model: firstModelMatching(provider, looksLikeRerankModel) ?? defaultRerankModelForProvider(provider.provider_type),
          metering: { subject_user_id: identity.userId },
          spend: { kind: "person", user_id: identity.userId },
        });
        const success = (embedding ? embedding.vectors.length > 0 : true) && (rerank ? rerank.scores.length > 0 : true);
        const message = scope === "embedding"
          ? "Embedding connection successful"
          : scope === "rerank"
            ? "Rerank connection successful"
            : "Embedding and rerank connection successful";
        const model = [embedding?.model, rerank?.model].filter(Boolean).join("; ");
        return reply.send({
          success,
          message,
          model,
        });
      }
      const models = await store.listConfiguredModels(identity.spaceId, provider.id);
      const model = provider.default_model || models[0];
      if (!model) return reply.send({ success: false, message: "No models configured" });
      const result = await completeProviderChat(store, identity.spaceId, {
        provider_id: provider.id,
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        metering: { subject_user_id: identity.userId },
        spend: { kind: "person", user_id: identity.userId },
      });
      return reply.send({
        success: true,
        message: "Connection successful",
        model: result.model,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed";
      return reply.send({ success: false, message });
    }
  });

  // ----- Credential pool management ---------------------------------------

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

  app.post("/api/v1/providers/:configId/credentials", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<ProviderPoolCredentialAddInput>(
        "ProviderPoolCredentialAddRequestSchema",
        jsonBody(request),
      );
      const member = await resolveProviderCommandStore(config).addPoolCredential(
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
        body,
      );
      return reply.code(201).send(member);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.delete("/api/v1/providers/:configId/credentials/:memberId", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await resolveProviderCommandStore(config).removePoolCredential(
        identity.spaceId,
        identity.userId,
        params(request).configId ?? "",
        params(request).memberId ?? "",
      );
      return reply.code(204).send();
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.patch("/api/v1/providers/:configId/credentials/config", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{
        rotation_strategy?: RotationStrategy;
        fallback_provider_ids?: string[];
      }>("ProviderPoolConfigUpdateRequestSchema", jsonBody(request));
      return reply.send(
        await resolveProviderCommandStore(config).updatePoolConfig(
          identity.spaceId,
          identity.userId,
          params(request).configId ?? "",
          body as ProviderPoolConfigUpdateInput,
        ),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // ----- Per-auxiliary-task provider chains --------------------------------

  app.get("/api/v1/providers/task-policies", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    return reply.send(
      await resolveProviderCommandStore(config).listTaskPolicies(identity.spaceId),
    );
  });

  app.put("/api/v1/providers/task-policies/:task", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{ chain: ProviderTaskChainEntry[]; enabled?: boolean }>(
        "ProviderTaskPolicyPutRequestSchema",
        jsonBody(request),
      );
      const task = params(request).task ?? "";
      const store = resolveProviderCommandStore(config);
      const updated = await store.putTaskPolicy(
        identity.spaceId,
        identity.userId,
        task,
        body.chain,
        body.enabled,
      );
      if (task === RETRIEVAL_EMBEDDING_TASK) {
        await resetRetrievalEmbeddingsForSpace(config, identity.spaceId);
        await enqueueRetrievalEmbeddingBackfill(config, {
          spaceId: identity.spaceId,
          userId: identity.userId,
          trigger: "retrieval_embedding_policy_update",
        });
      }
      return reply.send(updated);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.delete("/api/v1/providers/task-policies/:task", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const task = params(request).task ?? "";
      await resolveProviderCommandStore(config).deleteTaskPolicy(
        identity.spaceId,
        identity.userId,
        task,
      );
      if (task === RETRIEVAL_EMBEDDING_TASK) {
        await resetRetrievalEmbeddingsForSpace(config, identity.spaceId);
        await enqueueRetrievalEmbeddingBackfill(config, {
          spaceId: identity.spaceId,
          userId: identity.userId,
          trigger: "retrieval_embedding_policy_delete",
        });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}
