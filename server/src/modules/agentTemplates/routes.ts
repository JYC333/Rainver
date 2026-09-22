import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  jsonBody,
  objectValue,
  optionalObject,
  optionalString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { PgAgentRepository } from "../agents/index.js";
import { agentTemplateSystemPromptKey, resolveAgentSystemPrompt, type ResolvedAgentSystemPrompt } from "../agents/promptRegistry.js";
import { promptProvenanceOf } from "../prompts/provenance.js";
import { resolveContentCreationContext } from "../access/creationContext.js";
import { parseExecutionConstraints, rejectRetiredAgentDeploymentFields } from "../agents/agentRouteInputs.js";

interface TemplateSpec {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  visibility: string;
  status: string;
  version: Record<string, unknown>;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/agent-templates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const status = optionalString((request.query as Record<string, string | undefined>).status);
      const items = (await listSpecs(context.config.catalogRoot))
        .filter((template) => template.visibility !== "system_internal")
        .filter((template) => !status || template.status === status)
        .map(templateToOut);
      return reply.send(items);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agent-templates/:templateId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const template = await findSpec(context.config.catalogRoot, param(request, "templateId"));
      if (!template || template.visibility === "system_internal") {
        return reply.code(404).send({ detail: "Agent template not found" });
      }
      return reply.send(templateToOut(template));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agent-templates/:templateId/versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const template = await findSpec(context.config.catalogRoot, param(request, "templateId"));
      if (!template || template.visibility === "system_internal") {
        return reply.code(404).send({ detail: "Agent template not found" });
      }
      return reply.send([templateVersionToOut(template)]);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agent-templates/:templateId/versions/:versionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const template = await findSpec(context.config.catalogRoot, param(request, "templateId"));
      if (!template || template.visibility === "system_internal") {
        return reply.code(404).send({ detail: "Agent template not found" });
      }
      const version = templateVersionToOut(template);
      if (param(request, "versionId") !== version.id && param(request, "versionId") !== version.version) {
        return reply.code(404).send({ detail: "Agent template version not found" });
      }
      return reply.send(version);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/agent-templates/:templateId/agents", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const template = await findSpec(context.config.catalogRoot, param(request, "templateId"));
      if (!template || template.visibility === "system_internal") {
        return reply.code(404).send({ detail: "Agent template not found" });
      }
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      const version = templateVersionToOut(template);
      const requestedVersion = optionalString(body.template_version_id);
      if (requestedVersion && requestedVersion !== version.id && requestedVersion !== version.version) {
        throw new HttpError(404, "Agent template version not found");
      }
      rejectRetiredAgentDeploymentFields(body);
      const executionConstraints = parseExecutionConstraints(
        body.execution_constraints ?? version.execution_constraints,
      );
      const requestSystemPrompt = optionalString(body.system_prompt);
      const resolvedSystemPrompt = requestSystemPrompt
        ? null
        : await resolveTemplateSystemPrompt(
            context,
            { spaceId: creation.spaceId, userId: identity.userId },
            template.key,
          );
      const systemPrompt = requestSystemPrompt ?? resolvedSystemPrompt?.system ?? null;
      if (!systemPrompt) throw new HttpError(500, "Agent template system prompt is not resolvable");
      const agent = await PgAgentRepository.fromConfig(context.config).create({
        spaceId: creation.spaceId,
        projectId: creation.projectId,
        userId: identity.userId,
        name: optionalString(body.name) ?? template.name,
        description: body.description === undefined
          ? template.description
          : optionalString(body.description),
        visibility: creation.visibility,
        systemPrompt,
        promptProvenanceJson: resolvedSystemPrompt
          ? promptProvenanceOf(resolvedSystemPrompt.resolveResult)
          : null,
        contextPolicyJson: optionalObject(body.context_policy_json) ?? version.context_policy_json,
        memoryPolicyJson: optionalObject(body.memory_policy_json) ?? version.memory_policy_json,
        riskLevel: executionConstraints.risk_level,
        maxRunTimeSeconds: executionConstraints.max_run_time_seconds,
        toolPolicyJson: optionalObject(body.tool_policy_json) ?? version.tool_policy_json,
        outputPolicyJson: optionalObject(body.output_policy_json) ?? version.output_policy_json,
        scheduleConfigJson: optionalObject(body.schedule_config_json) ?? version.schedule_defaults_json,
        outputSchemaJson: optionalObject(body.output_schema_json) ?? version.output_schema_json,
      });
      return reply.code(201).send(agent);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

async function resolveTemplateSystemPrompt(
  context: ModuleContext,
  identity: { spaceId: string; userId: string },
  templateKey: string,
): Promise<ResolvedAgentSystemPrompt> {
  const resolved = await resolveAgentSystemPrompt(dbPool(context.config), {
    spaceId: identity.spaceId,
    userId: identity.userId,
    assetKey: agentTemplateSystemPromptKey(templateKey),
  });
  if (!resolved) throw new HttpError(500, "Agent template system prompt is not resolvable");
  return resolved;
}

async function listSpecs(catalogRoot: string): Promise<TemplateSpec[]> {
  const root = join(catalogRoot, "agent_templates");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const specs: TemplateSpec[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "template.yaml");
    try {
      if (!(await stat(path)).isFile()) continue;
      const parsed = parse(await readFile(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const doc = parsed as Record<string, unknown>;
      const key = optionalString(doc.key) ?? entry.name;
      specs.push({
        id: key,
        key,
        name: optionalString(doc.name) ?? key,
        description: optionalString(doc.description),
        category: optionalString(doc.category),
        visibility: optionalString(doc.visibility) ?? "system_public",
        status: optionalString(doc.status) ?? "published",
        version: doc,
      });
    } catch {
      // Invalid catalog entries are skipped from the product template library.
    }
  }
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

async function findSpec(catalogRoot: string, templateId: string): Promise<TemplateSpec | null> {
  return (await listSpecs(catalogRoot)).find((template) =>
    template.id === templateId || template.key === templateId
  ) ?? null;
}

function templateToOut(template: TemplateSpec): Record<string, unknown> {
  const now = new Date(0).toISOString();
  return {
    id: template.id,
    key: template.key,
    name: template.name,
    description: template.description,
    category: template.category,
    scope: "system",
    space_id: null,
    owner_user_id: null,
    visibility: template.visibility,
    status: template.status,
    current_version_id: versionId(template),
    created_at: now,
    updated_at: now,
  };
}

function templateVersionToOut(template: TemplateSpec): Record<string, unknown> & {
  id: string;
  version: string;
  system_prompt: string | null;
  context_policy_json: Record<string, unknown>;
  memory_policy_json: Record<string, unknown>;
  tool_policy_json: Record<string, unknown>;
  execution_constraints: { risk_level: string; max_run_time_seconds: number };
  output_policy_json: Record<string, unknown>;
  schedule_defaults_json: Record<string, unknown>;
  output_schema_json: Record<string, unknown>;
} {
  const doc = template.version;
  const now = new Date(0).toISOString();
  return {
    id: versionId(template),
    template_id: template.id,
    version: optionalString(doc.version) ?? "v1",
    // Template system prompts are managed by catalog/prompts and resolved by
    // prompt asset key at create time. Do not expose the legacy template.yaml
    // copy as an editable default.
    system_prompt: null,
    context_policy_json: objectValue(doc.context_policy),
    memory_policy_json: objectValue(doc.memory_policy),
    tool_policy_json: objectValue(doc.tool_policy),
    execution_constraints: parseExecutionConstraints(doc.execution_constraints),
    output_policy_json: objectValue(doc.output_policy),
    schedule_defaults_json: objectValue(doc.schedule_defaults),
    output_schema_json: objectValue(doc.output_schema),
    created_by_user_id: null,
    created_at: now,
    published_at: now,
  };
}

function versionId(template: TemplateSpec): string {
  return `${template.key}:v1`;
}

function param(request: { params: unknown }, name: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  return value ?? "";
}
