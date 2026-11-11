import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { FastifyInstance } from "fastify";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  objectValue,
  optionalString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { parseExecutionConstraints } from "../agents/agentRouteInputs.js";

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
  // Formal adapter: the core resolves Personal/Project placement and creates through the Agent writer.
  registerOperationAdapters(app, context.config, [{ method: "POST", url: "/api/v1/agent-templates/:templateId/agents", operation: "agent.template.instantiate", params: { templateId: "template_id" } }]);
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

export async function findSpec(catalogRoot: string, templateId: string): Promise<TemplateSpec | null> {
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

export function templateVersionToOut(template: TemplateSpec): Record<string, unknown> & {
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
    // prompt asset key at create time. Do not expose the template.yaml
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
