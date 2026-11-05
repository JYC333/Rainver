import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ORDINARY_TOOL_CATALOG,
  ORDINARY_TOOL_IDS,
  OrdinaryToolIdSchema,
  type HostOrdinaryTool,
  type HostOrdinaryToolsResponse,
  type OrdinaryToolAction,
  type OrdinaryToolReport,
} from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { introspectIdentity } from "../auth/identity.js";
import { getDbPool } from "../../db/pool.js";
import { isInstanceAdmin } from "../routeUtils/access.js";
import { managedHostEgressTransport, readInstanceOperationsPolicy } from "../settings/index.js";
import { normalizeHostCapabilities } from "./capabilities.js";
import { sharedHostConnectionRegistry } from "./connectionRegistry.js";
import { resolveOwnedHost } from "./routes.js";

/**
 * Ordinary CLI tools on a Host (protocol `ordinaryTools.ts`).
 *
 * Reading follows Host visibility: the built-in Host is every member's to see
 * (B63 — members see what is installed), a paired Host only its owner's.
 * Managing follows `resolveOwnedHost`: instance admin for the built-in Host,
 * owner-only for a paired one. Nothing is executed on the control plane; an
 * offline Host or one whose daemon predates the report answers without a
 * fallback.
 */
export function registerOrdinaryToolRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/hosts/:hostId/ordinary-tools", async (request, reply) => {
    if (!context.config.databaseUrl) return reply.code(502).send({ detail: "Identity database is unavailable" });
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) {
      return reply.code(identity.reason === "denied" ? identity.statusCode : 502).send({ detail: "Unauthorized" });
    }
    const hostId = (request.params as Record<string, string | undefined>).hostId ?? "";
    const pool = getDbPool(context.config.databaseUrl);
    const row = (await pool.query<{ id: string; kind: string; capabilities_json: unknown }>(
      `SELECT id, kind, capabilities_json FROM hosts
        WHERE id = $1 AND status <> 'revoked'
          AND (kind = 'server' OR (kind = 'remote' AND owner_user_id = $2))
        LIMIT 1`,
      [hostId, identity.userId],
    )).rows[0];
    if (!row) return reply.code(404).send({ detail: "Host not found" });
    const canManage = row.kind === "remote" || await isInstanceAdmin(context.config, identity.userId);
    return reply.send(ordinaryToolsView(row.id, row.capabilities_json, canManage));
  });

  app.post("/api/v1/hosts/:hostId/ordinary-tools/:toolId/install", async (request, reply) => {
    const tool = toolParam(request, reply);
    if (!tool) return reply;
    const recipe = ORDINARY_TOOL_CATALOG[tool].managed;
    if (!recipe) return reply.code(422).send({ detail: "This tool has no managed installation; register the machine's own copy instead." });
    return operate(context, request, reply, { action: "install", tool_id: tool, version: recipe.version });
  });

  app.post("/api/v1/hosts/:hostId/ordinary-tools/:toolId/register", async (request, reply) => {
    const tool = toolParam(request, reply);
    if (!tool) return reply;
    const path = jsonBody(request).path;
    if (path !== undefined && path !== null && (typeof path !== "string" || path.length === 0 || path.length > 4096)) {
      return reply.code(422).send({ detail: "path must be an absolute path string or omitted" });
    }
    return operate(context, request, reply, { action: "register", tool_id: tool, path: path ?? null });
  });

  app.delete("/api/v1/hosts/:hostId/ordinary-tools/:toolId", async (request, reply) => {
    const tool = toolParam(request, reply);
    if (!tool) return reply;
    const source = (request.query as Record<string, unknown> | undefined)?.source;
    if (source !== "managed" && source !== "registered") {
      return reply.code(422).send({ detail: "source must be 'managed' or 'registered'" });
    }
    return operate(context, request, reply, { action: "remove", tool_id: tool, source });
  });
}

function toolParam(request: FastifyRequest, reply: FastifyReply) {
  const parsed = OrdinaryToolIdSchema.safeParse((request.params as Record<string, unknown>).toolId);
  if (parsed.success) return parsed.data;
  void reply.code(422).send({ detail: "Unknown tool" });
  return null;
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const raw = request.body;
  const text = raw instanceof Buffer ? raw.toString("utf8") : typeof raw === "string" ? raw : null;
  if (raw && typeof raw === "object" && !(raw instanceof Buffer)) return raw as Record<string, unknown>;
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function operate(context: ModuleContext, request: FastifyRequest, reply: FastifyReply, operation: OrdinaryToolAction) {
  const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
  if (!resolved) return reply;
  const host = (await resolved.pool.query<{ kind: string; platform: string | null; capabilities_json: unknown }>(
    "SELECT kind, platform, capabilities_json FROM hosts WHERE id = $1",
    [resolved.hostId],
  )).rows[0];
  // Only Linux and macOS Hosts are supported: the catalog's executables are
  // bare POSIX names and its recipes are POSIX archives. A Windows Host is
  // refused here rather than offered something its daemon would mis-resolve.
  if (host?.platform !== "linux" && host?.platform !== "darwin") {
    return reply.code(422).send({ detail: "Ordinary CLI tools are supported on Linux and macOS Hosts only." });
  }
  // Syntax only, for that Host's platform; the daemon resolves and verifies
  // the file. The control plane never reads a remote path (B64).
  if (operation.action === "register" && operation.path !== null && !posixAbsoluteCommandPath(operation.path)) {
    return reply.code(422).send({ detail: "path must be an absolute path on the Host, without NUL characters." });
  }
  const report = normalizeHostCapabilities(host?.capabilities_json).ordinary_tools;
  if (!report) {
    // Checked against what the daemon said it speaks, not its version
    // number; an older daemon is told nothing it would reject.
    return reply.code(409).send({ code: "host_update_required", detail: "Update this Host's rainver-host to manage ordinary CLI tools." });
  }
  const result = await sharedHostConnectionRegistry.requestOrdinaryTool(resolved.hostId, {
    operation,
    ...(operation.action === "install" && host?.kind === "server"
      ? { egress_transport: managedHostEgressTransport(await readInstanceOperationsPolicy(context.config)) }
      : {}),
  });
  // The web client reads `detail`.
  return reply.code(result.ok ? 200 : result.error === "host_offline" ? 409 : 502)
    .send({ host_id: resolved.hostId, tool_id: operation.tool_id, ...result, ...(result.ok ? {} : { detail: result.error }) });
}

function posixAbsoluteCommandPath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\0") && path.length <= 4096;
}

/** The DTO for one Host: catalog order, with what the daemon last reported. */
export function ordinaryToolsView(hostId: string, capabilities: unknown, canManage: boolean): HostOrdinaryToolsResponse {
  const online = sharedHostConnectionRegistry.isOnline(hostId);
  const report = normalizeHostCapabilities(capabilities).ordinary_tools;
  const reported = new Map<string, OrdinaryToolReport>((report?.tools ?? []).map((tool) => [tool.tool_id, tool]));
  const tools = ORDINARY_TOOL_IDS.map((id): HostOrdinaryTool => {
    const entry = ORDINARY_TOOL_CATALOG[id];
    const seen = reported.get(id);
    const catalogVersion = entry.managed?.version ?? null;
    return {
      tool_id: id,
      label: entry.label,
      executable: entry.executable,
      requires_account: entry.requires_account,
      host_status: seen?.status ?? "unknown",
      reported_live: Boolean(seen) && online,
      source: seen?.source ?? null,
      version: seen?.version ?? null,
      version_text: seen?.version_text ?? null,
      registered: seen?.registered ?? false,
      managed: {
        catalog_version: catalogVersion,
        installed_version: seen?.managed_version ?? null,
        // Both ends must carry this version: the daemon installs only from its own catalog.
        installable: Boolean(seen?.managed_installable && catalogVersion && seen.managed_catalog_version === catalogVersion),
        update_available: Boolean(seen?.managed_version && catalogVersion && seen.managed_version !== catalogVersion),
      },
      sandbox_status: "not_verified",
      account_status: entry.requires_account ? "not_verified" : "not_applicable",
    };
  });
  return {
    host_id: hostId,
    host_state: !report ? (online ? "update_required" : "offline") : online ? "online" : "offline",
    can_manage: canManage,
    operations: sharedHostConnectionRegistry.ordinaryToolOperations(hostId),
    tools,
  };
}
