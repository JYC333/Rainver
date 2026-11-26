import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { FastifyInstance } from "fastify";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  objectValue,
  optionalString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { parseExecutionConstraints } from "../agents/agentRouteInputs.js";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { operationPackages } from "../plugins/operationRegistry.js";
import { getDbPool } from "../../db/pool.js";
import { operationPluginEnabled } from "../plugins/operationEnablement.js";
import { isPluginProjectBound, projectBoundManifest } from "../plugins/projectBindings.js";
import { canReadProject } from "../projects/access.js";

interface RoleSpec {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  visibility: string;
  status: string;
  version: Record<string, unknown>;
  /** The plugin that contributes this Role; null for a catalog Role. */
  pluginId: string | null;
  /** A plugin Role's own system prompt; catalog Roles resolve theirs by asset key. */
  systemPrompt: string | null;
}

/**
 * Who is asking, and from which Project. A plugin's Role is a Project-specific
 * assistant: it is offered only with a Project the viewer reads, while the
 * plugin is enabled for them and (for a Project-bound package) bound to that
 * Project. Without a Project — the global Role library and New Agent — no
 * plugin Role exists. `lockBinding` takes the binding row `FOR SHARE`, the
 * strength an unbind waits on, for a creation deciding under its transaction.
 */
export interface RoleViewer { db: Queryable; spaceId: string; userId: string; projectId?: string | null; lockBinding?: boolean }

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  // Formal adapter: the core resolves Personal/Project placement and creates through the Agent writer.
  registerOperationAdapters(app, context.config, [{ method: "POST", url: "/api/v1/agent-roles/:roleId/agents", operation: "agent.role.instantiate", params: { roleId: "role_id" } }]);
  app.get("/api/v1/agent-roles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const status = optionalString((request.query as Record<string, string | undefined>).status);
      const items = (await listSpecs(context.config, viewerOf(context.config, identity, request)))
        .filter((role) => role.visibility !== "system_internal")
        .filter((role) => !status || role.status === status)
        .map(roleToOut);
      return reply.send(items);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agent-roles/:roleId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const role = await findSpec(context.config, param(request, "roleId"), viewerOf(context.config, identity, request));
      if (!role || role.visibility === "system_internal") {
        return reply.code(404).send({ detail: "Agent role not found" });
      }
      return reply.send(roleToOut(role));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agent-roles/:roleId/versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const role = await findSpec(context.config, param(request, "roleId"), viewerOf(context.config, identity, request));
      if (!role || role.visibility === "system_internal") {
        return reply.code(404).send({ detail: "Agent role not found" });
      }
      return reply.send([roleVersionToOut(role)]);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/agent-roles/:roleId/versions/:versionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const role = await findSpec(context.config, param(request, "roleId"), viewerOf(context.config, identity, request));
      if (!role || role.visibility === "system_internal") {
        return reply.code(404).send({ detail: "Agent role not found" });
      }
      const version = roleVersionToOut(role);
      if (param(request, "versionId") !== version.id && param(request, "versionId") !== version.version) {
        return reply.code(404).send({ detail: "Agent role version not found" });
      }
      return reply.send(version);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}

async function listSpecs(config: ServerConfig, viewer: RoleViewer): Promise<RoleSpec[]> {
  const specs = [...await catalogSpecs(config.catalogRoot), ...await pluginSpecs(config, viewer)];
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

/**
 * Roles official plugins contribute (`RainverPlugin.agentRoles`), for the
 * viewer's Project where each plugin is set up now (`RoleViewer`). An unbound
 * or disabled plugin's Role is neither listed nor instantiable there; Agents
 * already created from it are kept and managed from My Agents.
 */
async function pluginSpecs(config: ServerConfig, viewer: RoleViewer): Promise<RoleSpec[]> {
  const specs: RoleSpec[] = [];
  const projectId = viewer.projectId;
  if (!projectId) return specs;
  let readable: boolean | null = null;
  for (const facts of operationPackages(config)) {
    const roles = facts.agentRoles ?? [];
    if (!roles.length) continue;
    // An archived Project offers no assistant to create, as its write gate refuses one.
    readable ??= await canReadProject(viewer.db, viewer.spaceId, projectId, viewer.userId)
      && Boolean((await viewer.db.query("SELECT 1 FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL AND status='active'",
        [projectId, viewer.spaceId])).rows.length);
    if (!readable) return specs;
    if (!await operationPluginEnabled(viewer.db, facts.id, viewer.spaceId, viewer.userId, config)) continue;
    if (projectBoundManifest(config, facts.id)
      && !await isPluginProjectBound(viewer.db, facts.id, viewer.spaceId, projectId, viewer.lockBinding)) continue;
    for (const role of roles) {
      const id = `${facts.id}.${role.key}`;
      specs.push({
        id, key: id, name: role.name, description: role.description,
        category: role.category ?? null, visibility: "system_public", status: "published",
        version: {
          tool_policy: role.tool_policy ?? {}, memory_policy: role.memory_policy ?? {},
          execution_constraints: role.execution_constraints ?? {},
        },
        pluginId: facts.id, systemPrompt: role.system_prompt,
      });
    }
  }
  return specs;
}

async function catalogSpecs(catalogRoot: string): Promise<RoleSpec[]> {
  const root = join(catalogRoot, "agent_roles");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const specs: RoleSpec[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "role.yaml");
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
        pluginId: null,
        systemPrompt: null,
      });
    } catch {
      // Invalid catalog entries are skipped from the product role library.
    }
  }
  return specs;
}

export async function findSpec(config: ServerConfig, roleId: string, viewer: RoleViewer): Promise<RoleSpec | null> {
  return (await listSpecs(config, viewer)).find((role) =>
    role.id === roleId || role.key === roleId
  ) ?? null;
}

function roleToOut(role: RoleSpec): Record<string, unknown> {
  const now = new Date(0).toISOString();
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    category: role.category,
    scope: "system",
    space_id: null,
    owner_user_id: null,
    visibility: role.visibility,
    status: role.status,
    source_plugin_id: role.pluginId,
    current_version_id: versionId(role),
    created_at: now,
    updated_at: now,
  };
}

export function roleVersionToOut(role: RoleSpec): Record<string, unknown> & {
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
  const doc = role.version;
  const now = new Date(0).toISOString();
  return {
    id: versionId(role),
    role_id: role.id,
    version: optionalString(doc.version) ?? "v1",
    // Role system prompts are managed by catalog/prompts and resolved by
    // prompt asset key at create time. Do not expose the role.yaml
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

function versionId(role: RoleSpec): string {
  return `${role.key}:v1`;
}

/** `?project_id=` names the Project a plugin's page asks from; nothing else offers plugin Roles. */
function viewerOf(config: ServerConfig, identity: { spaceId: string; userId: string }, request: { query: unknown }): RoleViewer {
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required.");
  const projectId = optionalString((request.query as Record<string, unknown> | undefined)?.project_id);
  return { db: getDbPool(config.databaseUrl), spaceId: identity.spaceId, userId: identity.userId, projectId };
}

function param(request: { params: unknown }, name: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  return value ?? "";
}
