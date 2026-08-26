import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { getDbPool } from "../../db/pool.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { RuntimeToolError, RuntimeToolRegistry } from "./service.js";
import {
  RuntimeToolPolicyRepository,
  type SpaceRuntimeToolPolicy,
} from "./policies.js";
import { SpaceAssistantService } from "../agents/spaceAssistantService.js";

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function bodyText(request: FastifyRequest): string {
  return request.body instanceof Buffer ? request.body.toString("utf8") : "";
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const text = bodyText(request);
  const parsed = text ? JSON.parse(text) : {};
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ spaceId: string; userId: string } | null> {
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

function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RuntimeToolError) {
    return reply.code(error.statusCode).send({ detail: error.message, error_code: error.code });
  }
  if (error && typeof error === "object" && "statusCode" in error) {
    const statusCode = Number((error as { statusCode: unknown }).statusCode);
    const message = error instanceof Error ? error.message : "Request failed";
    return reply.code(Number.isInteger(statusCode) ? statusCode : 400).send({ detail: message });
  }
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(400).send({ detail: message });
}

function db(context: ModuleContext) {
  if (!context.config.databaseUrl) throw new RuntimeToolError("database_unavailable", "SERVER_DATABASE_URL is required.", 502);
  return getDbPool(context.config.databaseUrl);
}

async function requireInstanceAdmin(context: ModuleContext, userId: string): Promise<void> {
  const adminEmail = context.config.instanceAdminEmail;
  if (!adminEmail) {
    throw new RuntimeToolError("instance_admin_not_configured", "INSTANCE_ADMIN_EMAIL is not configured.", 403);
  }
  const rows = await db(context).query<{ email: string | null }>(
    `SELECT email FROM users WHERE id = $1 AND status = 'active' LIMIT 1`,
    [userId],
  );
  const email = rows.rows[0]?.email?.trim().toLowerCase() ?? null;
  if (!email || email !== adminEmail) {
    throw new RuntimeToolError("instance_admin_required", "Requires instance admin.", 403);
  }
}

function allowedVersions(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            .map((item) => item.trim()),
        ),
      ]
    : [];
}

function policyEnvelope(
  status: Awaited<ReturnType<RuntimeToolRegistry["status"]>>,
  policy: SpaceRuntimeToolPolicy | null,
): Record<string, unknown> {
  return {
    runtime: status.runtime,
    label: status.label,
    enabled: policy?.enabled ?? false,
    default_version: policy?.default_version ?? null,
    allowed_versions: policy?.allowed_versions ?? [],
    policy_id: policy?.id ?? null,
    active_version: status.active_version,
    installed_versions: status.installed_versions,
    warnings: status.warnings,
    updated_by_user_id: policy?.updated_by_user_id ?? null,
    updated_at: policy?.updated_at ?? null,
  };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const registry = new RuntimeToolRegistry(context.config);

  app.get("/api/v1/runtime-tools/catalog", async (request, reply) => {
    if (!(await resolveIdentity(context, request, reply))) return reply;
    return reply.send(registry.listDefinitions());
  });

  app.get("/api/v1/runtime-tools", async (request, reply) => {
    if (!(await resolveIdentity(context, request, reply))) return reply;
    return reply.send(await registry.listStatus());
  });

  app.get("/api/v1/runtime-tools/space-policy", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const repository = new RuntimeToolPolicyRepository(db(context));
      const policies = await repository.list(identity.spaceId);
      const byRuntime = new Map(policies.map(policy => [policy.runtime, policy]));
      const statuses = await registry.listStatus();
      return reply.send(statuses.map(status => policyEnvelope(status, byRuntime.get(status.runtime) ?? null)));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/runtime-tools/space-policy/:runtime", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const runtime = params(request).runtime ?? "";
      const repository = new RuntimeToolPolicyRepository(db(context));
      const [status, policy] = await Promise.all([
        registry.status(runtime),
        repository.get(identity.spaceId, runtime),
      ]);
      return reply.send(policyEnvelope(status, policy));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.put("/api/v1/runtime-tools/space-policy/:runtime", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const runtime = params(request).runtime ?? "";
      const payload = jsonBody(request);
      const repository = new RuntimeToolPolicyRepository(db(context));
      const [statusForValidation, existingPolicy] = await Promise.all([
        registry.status(runtime),
        repository.get(identity.spaceId, runtime),
      ]);
      const hasDefaultVersion = Object.hasOwn(payload, "default_version");
      const defaultVersion = hasDefaultVersion
        ? typeof payload.default_version === "string" && payload.default_version.trim()
          ? payload.default_version.trim()
          : null
        : existingPolicy?.default_version ?? null;
      const nextAllowedVersions = Object.hasOwn(payload, "allowed_versions")
        ? allowedVersions(payload.allowed_versions)
        : existingPolicy?.allowed_versions ?? [];
      const enabled = typeof payload.enabled === "boolean"
        ? payload.enabled
        : existingPolicy?.enabled ?? false;
      if (enabled && defaultVersion) {
        const installedVersions = statusForValidation.installed_versions
          .filter(version => version.installed)
          .map(version => version.version);
        if (!installedVersions.includes(defaultVersion)) {
          return reply.code(409).send({ detail: `Runtime tool version '${defaultVersion}' is not installed` });
        }
        if (nextAllowedVersions.length > 0 && !nextAllowedVersions.includes(defaultVersion)) {
          return reply.code(422).send({ detail: "default_version must be included in allowed_versions" });
        }
      }
      const policy = await repository.upsert(identity, runtime, {
        enabled,
        default_version: defaultVersion,
        allowed_versions: nextAllowedVersions,
      });
      await SpaceAssistantService.reconcileCliProfiles(db(context), context.config, identity.spaceId);
      return reply.send(policyEnvelope(statusForValidation, policy));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/runtime-tools/:runtime", async (request, reply) => {
    if (!(await resolveIdentity(context, request, reply))) return reply;
    try {
      return reply.send(await registry.status(params(request).runtime ?? ""));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/runtime-tools/:runtime/latest", async (request, reply) => {
    if (!(await resolveIdentity(context, request, reply))) return reply;
    try {
      return reply.send(await registry.latestVersion(params(request).runtime ?? ""));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/runtime-tools/:runtime/install", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      await requireInstanceAdmin(context, identity.userId);
      const body = jsonBody(request);
      const result = await registry.install(params(request).runtime ?? "", {
        version: typeof body.version === "string" ? body.version : null,
        activate: typeof body.activate === "boolean" ? body.activate : true,
        force: body.force === true,
      });
      await SpaceAssistantService.reconcileCliProfilesForAllSpaces(db(context), context.config);
      return reply.code(201).send(result);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/runtime-tools/:runtime/activate", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      await requireInstanceAdmin(context, identity.userId);
      const body = jsonBody(request);
      if (typeof body.version !== "string" || body.version.trim() === "") {
        return reply.code(400).send({ detail: "version is required", error_code: "version_required" });
      }
      const result = await registry.activate(params(request).runtime ?? "", body.version);
      await SpaceAssistantService.reconcileCliProfilesForAllSpaces(db(context), context.config);
      return reply.send(result);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}
