import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { requireInstanceAdmin } from "../routeUtils/access.js";
import { BackupService } from "./service.js";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import { readInstanceOperationsPolicy } from "../settings/index.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  // `system.backup.create` (`system/settingsOperations.ts`): a system command receipt; the
  // archive name is released by `GET /api/v1/system/commands/:commandId`.
  registerOperationAdapters(app, context.config, [
    { method: "POST", url: "/api/v1/system/backups/manual", operation: "system.backup.create" },
  ]);
  const service = async () => new BackupService(
    context.config,
    await readInstanceOperationsPolicy(context.config),
  );

  app.get("/api/v1/system/backups", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    if (!context.config.backupEnabled) {
      return reply.send([]);
    }
    try {
      const backups = await (await service()).listBackups();
      return reply.send(
        backups.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          created_at: entry.created_at,
          size_bytes: entry.size_bytes,
        })),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
