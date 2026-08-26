import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@agent-space/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { checkInternalToken } from "../../gateway/internalAuth.js";
import { executeRuntimeHost } from "./service.js";
import { getDbPool } from "../../db/pool.js";
import type { RuntimeHostExecuteRequest } from "@agent-space/protocol";
import { authorizeRuntimeHostDelivery, bindRuntimeHostDeliveryRequest } from "./deliveryAuthorizer.js";

let deliveryAuthorizerOverride: ((input: RuntimeHostExecuteRequest) => Promise<void>) | null = null;

export function __setRuntimeHostDeliveryAuthorizerForTests(
  value: ((input: RuntimeHostExecuteRequest) => Promise<void>) | null,
): void {
  deliveryAuthorizerOverride = value;
}

function bodyText(request: FastifyRequest): string {
  return request.body instanceof Buffer ? request.body.toString("utf8") : "";
}

function jsonBody(request: FastifyRequest): unknown {
  const text = bodyText(request);
  return text ? JSON.parse(text) : {};
}

function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode =
    error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : 400;
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(Number.isInteger(statusCode) ? statusCode : 400).send({ detail: message });
}

async function parseWith<T>(schemaName: string, value: unknown): Promise<T> {
  const schema = (protocol as unknown as Record<string, { parse(v: unknown): T }>)[schemaName];
  return schema.parse(value);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/internal/runtime-host/execute", async (request, reply) => {
    if (!checkInternalToken(context.config, request)) {
      return reply.code(401).send({ detail: "Unauthorized" });
    }
    try {
      const body = await parseWith<Parameters<typeof executeRuntimeHost>[1]>(
        "RuntimeHostExecuteRequestSchema",
        jsonBody(request),
      );
      await assertRuntimeHostDelivery(context, body);
      const response = await executeRuntimeHost(context.config, body, request.log);
      return reply.send(protocol.RuntimeHostExecuteResponseSchema.parse(response));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}

async function assertRuntimeHostDelivery(
  context: ModuleContext,
  input: RuntimeHostExecuteRequest,
): Promise<void> {
  const refs = input.invocation_audit_refs;
  if (!refs) throw Object.assign(new Error("Runtime Host execution requires Invocation Delivery audit references"), { statusCode: 409 });
  if (deliveryAuthorizerOverride) return deliveryAuthorizerOverride(input);
  if (!context.config.databaseUrl) throw Object.assign(new Error("SERVER_DATABASE_URL is required"), { statusCode: 503 });
  const db = getDbPool(context.config.databaseUrl);
  await bindRuntimeHostDeliveryRequest(db, input);
  await authorizeRuntimeHostDelivery(db, input);
}
