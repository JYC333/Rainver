import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../routeUtils/common.js";
import type { PgAgentRepository } from "./repository.js";

export interface AgentConfigPatch {
  userId: string;
  name?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  modelProviderId?: string | null;
  modelName?: string | null;
  modelConfigJson?: Record<string, unknown> | null;
  contextPolicyJson?: Record<string, unknown> | null;
  memoryPolicyJson?: Record<string, unknown> | null;
  outputPolicyJson?: Record<string, unknown> | null;
  scheduleConfigJson?: Record<string, unknown> | null;
  outputSchemaJson?: Record<string, unknown> | null;
  runtimeConfigJson?: Record<string, unknown> | null;
}

export function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

export function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const text = request.body instanceof Buffer ? request.body.toString("utf8") : "";
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(422, "Invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(422, "JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

export async function applyAgentIdentityPatch(
  repository: PgAgentRepository,
  spaceId: string,
  userId: string,
  agentId: string,
  body: Record<string, unknown>,
) {
  const patch: {
    name?: string;
    description?: string | null;
    roleInstruction?: string | null;
    status?: string;
  } = {};
  if (Object.hasOwn(body, "name")) patch.name = requiredBodyString(body, "name");
  if (Object.hasOwn(body, "description")) {
    patch.description = nullableBodyString(body, "description");
  }
  if (body.visibility !== undefined || body.access_level !== undefined || body.grants !== undefined) {
    throw new HttpError(422, "Use the content-access API to update agent permissions");
  }
  if (Object.hasOwn(body, "role_instruction")) {
    patch.roleInstruction = nullableBodyString(body, "role_instruction");
  }
  if (Object.hasOwn(body, "status")) patch.status = requiredBodyString(body, "status");
  return Object.keys(patch).length > 0
    ? repository.update(spaceId, userId, agentId, patch)
    : null;
}

export function configPatch(
  body: Record<string, unknown>,
  userId: string,
): AgentConfigPatch {
  const patch: AgentConfigPatch = { userId };
  if (Object.hasOwn(body, "name")) patch.name = requiredBodyString(body, "name");
  if (Object.hasOwn(body, "description")) {
    patch.description = nullableBodyString(body, "description");
  }
  if (Object.hasOwn(body, "system_prompt")) {
    patch.systemPrompt = nullableBodyString(body, "system_prompt");
  }
  if (Object.hasOwn(body, "model_provider_id") || Object.hasOwn(body, "default_model_provider_id")) {
    patch.modelProviderId = nullableBodyString(
      body,
      Object.hasOwn(body, "model_provider_id") ? "model_provider_id" : "default_model_provider_id",
    );
  }
  if (Object.hasOwn(body, "model_name") || Object.hasOwn(body, "default_model")) {
    patch.modelName = nullableBodyString(
      body,
      Object.hasOwn(body, "model_name") ? "model_name" : "default_model",
    );
  }
  assignRecordPatch(patch, body, "model_config_json", "modelConfigJson");
  assignRecordPatch(patch, body, "context_policy_json", "contextPolicyJson");
  assignRecordPatch(patch, body, "memory_policy_json", "memoryPolicyJson");
  assignRecordPatch(patch, body, "output_policy_json", "outputPolicyJson");
  assignRecordPatch(patch, body, "schedule_config_json", "scheduleConfigJson");
  assignRecordPatch(patch, body, "output_schema_json", "outputSchemaJson");
  assignRecordPatch(patch, body, "runtime_config_json", "runtimeConfigJson");
  return patch;
}

export function hasConfigPatch(body: Record<string, unknown>): boolean {
  return [
    "system_prompt",
    "default_model_provider_id",
    "default_model",
    "model_provider_id",
    "model_name",
    "model_config_json",
    "context_policy_json",
    "memory_policy_json",
    "output_policy_json",
    "schedule_config_json",
    "output_schema_json",
    "runtime_config_json",
  ].some((key) => Object.hasOwn(body, key));
}

export function requiredBodyString(body: Record<string, unknown>, key: string): string {
  const value = nullableBodyString(body, key);
  if (!value) throw new HttpError(422, `${key} is required`);
  return value;
}

export function nullableBodyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, `${key} must be a string or null`);
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function optionalRecordBody(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  return nullableRecordBody(body, key);
}

export function nullableRecordBody(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = body[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new HttpError(422, `${key} must be an object or null`);
}

export function optionalArrayBody(
  body: Record<string, unknown>,
  key: string,
): unknown[] | null | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const value = body[key];
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  throw new HttpError(422, `${key} must be an array or null`);
}

export function optionalBooleanBody(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const value = body[key];
  if (typeof value === "boolean") return value;
  throw new HttpError(422, `${key} must be a boolean`);
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return reply
      .code((error as { statusCode: number }).statusCode)
      .send({ detail: error.message });
  }
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(400).send({ detail: message });
}

function assignRecordPatch(
  target: AgentConfigPatch,
  body: Record<string, unknown>,
  sourceKey: string,
  targetKey:
    | "modelConfigJson"
    | "contextPolicyJson"
    | "memoryPolicyJson"
    | "outputPolicyJson"
    | "scheduleConfigJson"
    | "outputSchemaJson"
    | "runtimeConfigJson",
): void {
  if (Object.hasOwn(body, sourceKey)) {
    target[targetKey] = nullableRecordBody(body, sourceKey);
  }
}
