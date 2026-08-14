/**
 * Provider read handlers.
 *
 * Providers/credentials are server-owned. Reads resolve identity through the
 * native auth module, then serve list/detail from the provider DB read port,
 * and the vendor registry and preset catalog from server-owned constants.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { listProviderVendors } from "./vendors";
import type { ServerConfig } from "../../config";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext";
import { resolveProvidersDbPort } from "./dbReader";
import { introspectIdentity } from "../auth/identity";
import { listProviderPresets as listProviderPresetCatalog } from "./presets";

function configIdFromRequest(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  return typeof params?.configId === "string" ? params.configId : undefined;
}

async function resolveIdentityOrReply(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  requestId: string,
): Promise<{ spaceId: string; userId: string } | FastifyReply> {
  const identity = await introspectIdentity(config, request);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    // Pass the auth module's denial response through unchanged.
    reply.code(identity.statusCode);
    reply.header("content-type", "application/json");
    return reply.send(identity.body);
  }
  return sendErrorEnvelope(
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
}

async function serveProviderRead(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  compute: (spaceId: string, userId: string) => Promise<unknown | null>,
  notFoundDetail?: (configId: string) => string,
): Promise<FastifyReply> {
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);

  const identityOrReply = await resolveIdentityOrReply(config, request, reply, requestId);
  if (!("spaceId" in identityOrReply)) return identityOrReply;

  let value: unknown | null;
  try {
    value = await compute(identityOrReply.spaceId, identityOrReply.userId);
  } catch (err) {
    request.log.error(
      { path: request.url, reason: err instanceof Error ? err.message : "unknown" },
      "providers server read failed",
    );
    return sendErrorEnvelope(
      reply,
      503,
      errorEnvelope(
        "providers_db_unavailable",
        "Provider database read failed",
        requestId,
      ),
    );
  }

  if (value === null) {
    const configId = configIdFromRequest(request) ?? "";
    reply.code(404);
    return reply.send({ detail: notFoundDetail?.(configId) ?? "Not found" });
  }
  reply.code(200);
  return reply.send(value);
}

function requireDbPort(config: ServerConfig) {
  const db = resolveProvidersDbPort(config);
  if (!db) {
    // Fixed provider authority needs the server DB URL in deployed
    // stacks. Keep tests and minimal local config able to boot, but fail reads
    // loudly if the route is called without a DB port.
    throw new Error("providers server authority requires SERVER_DATABASE_URL");
  }
  return db;
}

export function listProviderConfigs(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return serveProviderRead(config, request, reply, (spaceId, userId) =>
    requireDbPort(config).listProviders(spaceId, userId),
  );
}

export function getProviderConfig(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const configId = configIdFromRequest(request) ?? "";
  return serveProviderRead(
    config,
    request,
    reply,
    (spaceId, userId) => requireDbPort(config).getProvider(spaceId, userId, configId),
    (id) => `ModelProvider '${id}' not found`,
  );
}

export function listProviderPresets(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return serveProviderRead(config, request, reply, async () => listProviderPresetCatalog());
}

/** The server-owned vendor registry, served so the client stops keeping a copy. */
export async function listProviderVendorCatalog(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return serveProviderRead(config, request, reply, async () =>
    listProviderVendors().map((vendor) => ({
      id: vendor.id,
      display_name: vendor.displayName,
      protocol: vendor.protocol,
      supports_chat: vendor.supportsChat,
      supports_runtime_tools: vendor.supportsRuntimeTools,
      supports_structured_output: vendor.supportsStructuredOutput,
      supports_embedding: vendor.supportsEmbedding,
      supports_rerank: vendor.supportsRerank,
      default_base_url: vendor.defaultBaseUrl,
      api_key_required: vendor.apiKeyRequired,
      subscription_only: vendor.subscriptionOnly,
    })),
  );
}
