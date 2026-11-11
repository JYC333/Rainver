import type { FastifyInstance } from "fastify";
import {
  ORDINARY_TOOL_CATALOG,
  ORDINARY_TOOL_IDS,
  type HostOrdinaryTool,
  type HostOrdinaryToolsResponse,
  type OrdinaryToolReport,
} from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { introspectIdentity } from "../auth/identity.js";
import { getDbPool } from "../../db/pool.js";
import { isInstanceAdmin } from "../routeUtils/access.js";
import { normalizeHostCapabilities } from "./capabilities.js";
import { sharedHostConnectionRegistry } from "./connectionRegistry.js";
import { activeOrdinaryToolCommands } from "./operationRoutes.js";

/**
 * Ordinary CLI tools on a Host (protocol `ordinaryTools.ts`).
 *
 * Reading follows Host visibility: the built-in Host is every member's to see
 * (B63 — members see what is installed), a paired Host only its owner's.
 * Managing — install, register, remove — is a durable Host command
 * (`host.ordinary_tool.*`, `hosts/operations.ts`): instance admin for the
 * built-in Host, owner-only for a paired one. Nothing is executed on the
 * control plane; an offline Host or one whose daemon predates the report is
 * refused without a fallback.
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
    return reply.send(ordinaryToolsView(row.id, row.capabilities_json, canManage, await activeOrdinaryToolCommands(pool, row.id)));
  });
}

/** The DTO for one Host: catalog order, with what the daemon last reported. */
export function ordinaryToolsView(hostId: string, capabilities: unknown, canManage: boolean, durable: ReadonlyArray<{ tool_id: string; action: string }> = []): HostOrdinaryToolsResponse {
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
    // In flight on the socket, or committed and waiting for its Job: one entry per tool.
    operations: [...new Map([...durable, ...sharedHostConnectionRegistry.ordinaryToolOperations(hostId)]
      .map((item) => [item.tool_id, item] as const)).values()] as HostOrdinaryToolsResponse["operations"],
    tools,
  };
}
