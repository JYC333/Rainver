import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../routeUtils/common.js";
import type { PgAgentRepository } from "./repository.js";
import {
  AgentExecutionConstraintsPatchSchema,
  AgentExecutionConstraintsSchema,
  type AgentExecutionConstraints,
  type AgentExecutionConstraintsPatch,
} from "@rainver/protocol";

export interface AgentConfigPatch {
  userId: string;
  name?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  contextPolicyJson?: Record<string, unknown> | null;
  memoryPolicyJson?: Record<string, unknown> | null;
  toolPolicyJson?: Record<string, unknown> | null;
  outputPolicyJson?: Record<string, unknown> | null;
  scheduleConfigJson?: Record<string, unknown> | null;
  outputSchemaJson?: Record<string, unknown> | null;
  riskLevel?: "low" | "medium" | "high" | "critical";
  maxRunTimeSeconds?: number;
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
  rejectRetiredAgentDeploymentFields(body);
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
  rejectRetiredAgentDeploymentFields(body);
  const patch: AgentConfigPatch = { userId };
  if (Object.hasOwn(body, "name")) patch.name = requiredBodyString(body, "name");
  if (Object.hasOwn(body, "description")) {
    patch.description = nullableBodyString(body, "description");
  }
  if (Object.hasOwn(body, "system_prompt")) {
    patch.systemPrompt = nullableBodyString(body, "system_prompt");
  }
  assignRecordPatch(patch, body, "context_policy_json", "contextPolicyJson");
  assignRecordPatch(patch, body, "memory_policy_json", "memoryPolicyJson");
  assignRecordPatch(patch, body, "tool_policy_json", "toolPolicyJson");
  assignRecordPatch(patch, body, "output_policy_json", "outputPolicyJson");
  assignRecordPatch(patch, body, "schedule_config_json", "scheduleConfigJson");
  assignRecordPatch(patch, body, "output_schema_json", "outputSchemaJson");
  if (Object.hasOwn(body, "execution_constraints")) {
    const constraints = parseExecutionConstraintsPatch(body.execution_constraints);
    if (constraints.risk_level !== undefined) patch.riskLevel = constraints.risk_level;
    if (constraints.max_run_time_seconds !== undefined) {
      patch.maxRunTimeSeconds = constraints.max_run_time_seconds;
    }
  }
  return patch;
}

export function parseExecutionConstraints(value: unknown): AgentExecutionConstraints {
  const parsed = AgentExecutionConstraintsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new HttpError(422, `Invalid execution_constraints: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
  }
  return parsed.data;
}

export function parseExecutionConstraintsPatch(value: unknown): AgentExecutionConstraintsPatch {
  const parsed = AgentExecutionConstraintsPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(422, `Invalid execution_constraints: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
  }
  return parsed.data;
}

export function hasConfigPatch(body: Record<string, unknown>): boolean {
  return [
    "system_prompt",
    "context_policy_json",
    "memory_policy_json",
    "tool_policy_json",
    "output_policy_json",
    "schedule_config_json",
    "output_schema_json",
    "execution_constraints",
  ].some((key) => Object.hasOwn(body, key));
}

/**
 * Agent definition writes never carry deployment or backend selection.
 *
 * This is the Agent-definition body, which has no protocol schema of its own;
 * the names below are not "retired" here but owned by a different resource, so
 * the message points at the Runtime Profile API rather than rejecting them as
 * unknown. Profile bodies get the same answer out of
 * `AgentRuntimeProfile{Create,Update}BodySchema.strict()` instead.
 *
 * Every name here is one the Runtime Profile API actually owns. `adapter_type`
 * is not among them: it names nothing in this epoch, so pointing its author at
 * the Profile API would be directing them at a field that does not exist
 * there either.
 */
export function rejectRetiredAgentDeploymentFields(body: Record<string, unknown>): void {
  const retiredFields = [
    "runtime_key",
    "backend_mode",
    "model_provider_id",
    "model_name",
    "default_model_provider_id",
    "default_model",
    "model_config_json",
    "runtime_config_json",
    "runtime_policy_json",
    "execution_host_id",
    "workspace_location_id",
    "workspace_mode",
    "runtime_installation",
  ];
  const retired = retiredFields.find((field) => Object.hasOwn(body, field));
  if (retired) {
    throw new HttpError(422, `${retired} is Runtime Profile authority; configure it through the Runtime Profile API`);
  }
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
    | "contextPolicyJson"
    | "memoryPolicyJson"
    | "toolPolicyJson"
    | "outputPolicyJson"
    | "scheduleConfigJson"
    | "outputSchemaJson",
): void {
  if (Object.hasOwn(body, sourceKey)) {
    target[targetKey] = nullableRecordBody(body, sourceKey);
  }
}
