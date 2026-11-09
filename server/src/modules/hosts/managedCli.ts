import type { FastifyReply, FastifyRequest } from "fastify";
import { isOwnCliUpdateRuntimeKey, type HostServerFrameOf } from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveOwnedHost } from "./routes.js";
import { normalizeHostCapabilities } from "./capabilities.js";
import { ownCliReleases } from "./ownCliReleases.js";
import { sharedHostConnectionRegistry } from "./connectionRegistry.js";
import { recordHostRuntimeChange } from "./usageService.js";

export async function manageNativeCli(context: ModuleContext, request: FastifyRequest, reply: FastifyReply, action: "update" | "rollback") {
  const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
  if (!resolved) return reply;
  const key = (request.params as { runtimeKey: string }).runtimeKey;
  if (!isOwnCliUpdateRuntimeKey(key)) return reply.code(422).send({ detail: "This runtime has no separate CLI updater" });
  const row = await resolved.pool.query<{ capabilities_json: unknown }>("SELECT capabilities_json FROM hosts WHERE id = $1", [resolved.hostId]);
  const caps = normalizeHostCapabilities(row.rows[0]?.capabilities_json);
  if (!caps.managed_cli_updates) return reply.code(409).send({ detail: "Update this Host before managing its CLI versions" });
  if (!caps.installations[key]?.some(copy => copy.id !== "own")) return reply.code(409).send({ detail: "Install this managed CLI first" });
  let operation: HostServerFrameOf<"managed_cli">["operation"] = { action: "rollback" };
  if (action === "update") {
    const version = ownCliReleases.peek(key);
    if (!version) return reply.code(409).send({ detail: "The latest CLI release is not available yet. Refresh and retry." });
    operation = { action, version };
  }
  const result = await sharedHostConnectionRegistry.requestToolAction(resolved.hostId, "managed_cli", { runtime_key: key, operation });
  if (result.ok && result.from_version !== result.to_version) await recordHostRuntimeChange(resolved.pool, {
    hostId: resolved.hostId, runtimeKey: key, action: action === "update" ? "upgrade" : "rollback",
    fromVersion: result.from_version ?? null, toVersion: result.to_version ?? null, actorUserId: resolved.userId,
  });
  return reply.code(result.ok ? 200 : 502).send({ host_id: resolved.hostId, runtime_key: key, ...result, ...(result.ok ? {} : { detail: result.error }) });
}
