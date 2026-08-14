import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProviderFromPresetCreateRequest } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../../config";
import { errorEnvelope, sendErrorEnvelope } from "../../../gateway/errorEnvelope";
import { checkInternalToken } from "../../../gateway/internalAuth";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../../gateway/requestContext";
import { introspectIdentity } from "../../auth/identity";
import { loadProtocol } from "../protocolRuntime";
import { resolveProviderCommandStore } from "./store";
import type {
  ModelProviderCreateInput,
  ModelProviderUpdateInput,
  ProviderPoolConfigUpdateInput,
  ProviderPoolCredentialAddInput,
  ProviderTaskChainEntry,
  RotationStrategy,
} from "./store";
import { ProviderCommandForbiddenError } from "./store";
import {
  completeProviderChat,
  completeProviderEmbedding,
  completeProviderRerank,
  completeProviderText,
  listProviderModels,
} from "../invocation/invocation";
import { CliCredentialBroker } from "../cli/credentialBroker";
import {
  enqueueRetrievalEmbeddingBackfill,
  resetRetrievalEmbeddingsForSpace,
} from "../../retrieval/embedding/job";
import { RETRIEVAL_EMBEDDING_TASK } from "../../retrieval/embedding/config";
import { createProviderFromPreset } from "./fromPreset";
import { getDbPool } from "../db";
import {
  createManagedSubscriptionLoginSession,
  disconnectManagedSubscription,
  loginManagedSubscription,
  parseManagedSubscriptionType,
  refreshManagedSubscriptionQuota,
  type ManagedSubscriptionLoginSession,
} from "../subscriptionOAuth";
import { requireProviderVendor } from "../vendors";

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
  const protocol = await loadProtocol();
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
  const broker = new CliCredentialBroker(config, app.log);

  app.get("/api/v1/providers/subscriptions/login/stream", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await requireInstanceAdmin(config, identity.userId);
      const type = parseManagedSubscriptionType(query(request).type ?? "");
      const sessionKey = `${identity.userId}:${type}`;
      if (subscriptionLoginSessions.has(sessionKey)) {
        return reply.code(409).send({ detail: `A ${type} subscription login is already active` });
      }
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
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
      const target = await store.getInvocationTarget(
        identity.spaceId,
        params(request).configId ?? "",
        identity.userId,
      );
      const vendor = requireProviderVendor(target.provider.provider_type);
      if (!vendor.supportsChat && (vendor.supportsEmbedding || vendor.supportsRerank)) {
        const scope = retrievalProviderTestScope(target.provider);
        const embedding = scope === "rerank" ? null : await completeProviderEmbedding(store, identity.spaceId, {
          provider_id: target.provider.id,
          model: firstModelMatching(target.provider, looksLikeEmbeddingModel),
          inputs: ["agent-space retrieval provider connection test"],
          inputType: "document",
          metering: { subject_user_id: identity.userId },
        });
        const rerank = scope === "embedding" ? null : await completeProviderRerank(store, identity.spaceId, {
          provider_id: target.provider.id,
          query: "retrieval provider test",
          documents: ["retrieval provider test document", "unrelated document"],
          topN: 1,
          model: firstModelMatching(target.provider, looksLikeRerankModel) ?? defaultRerankModelForProvider(target.provider.provider_type),
          metering: { subject_user_id: identity.userId },
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
      const models = await store.listConfiguredModels(identity.spaceId, target.provider.id);
      const model = target.provider.default_model || models[0];
      if (!model) return reply.send({ success: false, message: "No models configured" });
      const result = await completeProviderChat(store, identity.spaceId, {
        provider_id: target.provider.id,
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        metering: { subject_user_id: identity.userId },
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

  app.get("/api/v1/credentials/cli/profiles", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    const runtime = query(request).runtime;
    const profiles = await broker.listProfiles(runtime, identity.spaceId, identity.userId);
    return reply.send(await Promise.all(profiles.map((p) => broker.profileOut(p))));
  });

  app.get("/api/v1/credentials/cli/available", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    return reply.send(
      await broker.availableProfiles(identity.spaceId, identity.userId, query(request).runtime),
    );
  });

  app.post("/api/v1/credentials/cli/profiles", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{
        runtime: string;
        name: string;
        readonly?: boolean;
        notes?: string;
        network_profile_id?: string | null;
        is_default?: boolean;
      }>("CliCredentialProfileCreateRequestSchema", jsonBody(request));
      return reply
        .code(201)
        .send(await broker.createProfile(identity.spaceId, identity.userId, body));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.put("/api/v1/credentials/cli/profiles/:profileId/grants", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{
        space_id: string;
        enabled?: boolean;
        is_default?: boolean;
        network_profile_id?: string | null;
      }>("CliCredentialSpaceGrantRequestSchema", jsonBody(request));
      return reply.send(
        await broker.grantCliProfileToSpace(
          identity.spaceId,
          identity.userId,
          params(request).profileId ?? "",
          body,
        ),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.delete("/api/v1/credentials/cli/profiles/:profileId/grants/:spaceId", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      await broker.revokeCliProfileGrant(
        identity.userId,
        params(request).profileId ?? "",
        params(request).spaceId ?? "",
      );
      return reply.code(204).send();
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/credentials/cli/profiles/:profileId", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    const profileId = params(request).profileId ?? "";
    const profile = await broker.getProfile(profileId, identity.spaceId, identity.userId);
    if (!profile) return reply.code(404).send({ detail: `Profile '${profileId}' not found` });
    return reply.send(await broker.profileOut(profile));
  });

  app.post("/api/v1/credentials/cli/profiles/:profileId/detect", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await broker.detectProfile(
          params(request).profileId ?? "",
          identity.spaceId,
          identity.userId,
        ),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.patch("/api/v1/credentials/cli/profiles/:profileId", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{ network_profile_id?: string | null }>(
        "CliCredentialProfileUpdateRequestSchema",
        jsonBody(request),
      );
      return reply.send(
        await broker.updateProfileNetworkProfileId(
          params(request).profileId ?? "",
          body.network_profile_id ?? null,
          identity.spaceId,
          identity.userId,
        ),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/credentials/cli/methods", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    return reply.send(broker.listLoginMethods());
  });

  app.get("/api/v1/credentials/cli/login/stream", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    await broker.streamLogin(
      query(request).runtime ?? "",
      reply,
      identity.spaceId,
      identity.userId,
      query(request).profile_id,
    );
    return reply;
  });

  app.post("/api/v1/credentials/cli/login/input", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{ input: string; profile_id?: string }>(
        "CliLoginInputRequestSchema",
        jsonBody(request),
      );
      if (!await broker.sendLoginInput(
        query(request).runtime ?? "",
        body.input,
        identity.spaceId,
        identity.userId,
        body.profile_id,
      )) {
        return reply
          .code(404)
          .send({ detail: `No active login session for runtime '${query(request).runtime ?? ""}'` });
      }
      return reply.send({ status: "sent" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/credentials/cli/status", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    return reply.send(await broker.status(identity.spaceId, identity.userId));
  });

  app.get("/api/v1/credentials/cli/usage", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    return reply.send(await broker.cliUsage(identity.spaceId, identity.userId));
  });

  app.get("/api/v1/credentials/cli/usage/auto-refresh", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    return reply.send(await broker.cliUsageAutoRefreshSettings());
  });

  app.put("/api/v1/credentials/cli/usage/auto-refresh", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      const body = await parseWith<{ enabled: boolean }>(
        "CliUsageAutoRefreshUpdateRequestSchema",
        jsonBody(request),
      );
      return reply.send(await broker.setCliUsageAutoRefresh(body.enabled));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/credentials/cli/usage/refresh", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await broker.refreshCliQuota(
          query(request).runtime ?? "",
          identity.spaceId,
          identity.userId,
          query(request).profile_id,
        ),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/internal/providers-credentials/providers/complete-text", async (request, reply) => {
    if (!checkInternalToken(config, request)) return reply.code(401).send({ detail: "Unauthorized" });
    try {
      const body = await parseWith<{
        space_id: string;
        provider_id: string;
        model?: string | null;
        system: string;
        user: string;
        max_tokens?: number;
        task?: string | null;
        subject_user_id?: string | null;
        source_resource_type?: string | null;
        source_resource_id?: string | null;
        space_system_task?: boolean;
        meter_subject_type?: string | null;
        meter_subject_id?: string | null;
      }>("ProviderCompletionInternalRequestSchema", jsonBody(request));
      return reply.send(
        await completeProviderText(resolveProviderCommandStore(config), body.space_id, {
          provider_id: body.provider_id,
          model: body.model,
          system: body.system,
          user: body.user,
          max_tokens: body.max_tokens,
          task: body.task,
          metering: {
            subject_user_id: body.subject_user_id,
            source_resource_type: body.source_resource_type,
            source_resource_id: body.source_resource_id,
            space_system_task: body.space_system_task,
            meter_subject_type: body.meter_subject_type,
            meter_subject_id: body.meter_subject_id,
          },
        }),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/internal/providers-credentials/credentials/runtime/resolve", async (request, reply) => {
    if (!checkInternalToken(config, request)) return reply.code(401).send({ detail: "Unauthorized" });
    try {
      const body = await parseWith<
        | { kind: "model_provider_api_key"; space_id: string; provider_id: string }
        | { kind: "credential_api_key"; space_id: string; credential_id: string }
        | {
            kind: "cli_profile";
            space_id: string;
            runtime: string;
            profile_id?: string | null;
            require_existing?: boolean;
            user_id: string;
          }
      >("RuntimeCredentialResolveRequestSchema", jsonBody(request));
      if (body.kind === "model_provider_api_key") {
        return reply.send({
          kind: "model_provider_api_key",
          provider_id: body.provider_id,
          api_key: await resolveProviderCommandStore(config).resolveProviderApiKey(
            body.space_id,
            body.provider_id,
          ),
        });
      }
      if (body.kind === "credential_api_key") {
        return reply.send({
          kind: "credential_api_key",
          credential_id: body.credential_id,
          api_key: await resolveProviderCommandStore(config).resolveCredentialApiKey(
            body.space_id,
            body.credential_id,
          ),
        });
      }
      const profile = await broker.resolveProfile(
        body.runtime,
        body.profile_id,
        body.require_existing ?? true,
        body.space_id,
        body.user_id,
      );
      if (!profile) return reply.code(404).send({ detail: "Credential profile not found" });
      return reply.send({
        kind: "cli_profile",
        profile_id: profile.id,
        runtime: profile.runtime,
        source_path: profile.source_path,
        target_path: profile.target_path,
        readonly: profile.readonly,
      });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/internal/providers-credentials/credentials/cli/grant", async (request, reply) => {
    if (!checkInternalToken(config, request)) return reply.code(401).send({ detail: "Unauthorized" });
    try {
      const body = await parseWith<{
        run_id: string;
        space_id: string;
        runtime: string;
        executor_mode: "worktree" | "docker";
        profile_id?: string | null;
        user_id: string;
      }>("CliCredentialGrantRequestSchema", jsonBody(request));
      return reply.send(
        await broker.grantForRun(
          body.run_id,
          body.space_id,
          body.runtime,
          body.executor_mode,
          body.profile_id,
          { user_id: body.user_id },
        ),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/internal/providers-credentials/credentials/cli/audit", async (request, reply) => {
    if (!checkInternalToken(config, request)) return reply.code(401).send({ detail: "Unauthorized" });
    try {
      const body = await parseWith<{
        space_id: string;
        run_id?: string | null;
        runtime_adapter_type?: string | null;
        credential_profile_id?: string | null;
        trigger_origin?: string | null;
        fallback_used?: boolean;
        fallback_reason?: string | null;
        broker_error?: boolean;
        cleanup_status?: string;
        action?: string;
      }>("CliCredentialAuditRequestSchema", jsonBody(request));
      const eventId = await resolveProviderCommandStore(config).recordCliCredentialUsage(body);
      return reply.send({ status: "recorded", event_id: eventId });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}
