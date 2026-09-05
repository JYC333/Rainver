import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { BackupService } from "./service.js";
import { readInstanceOperationsPolicy } from "../settings/index.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = async () => new BackupService(
    context.config,
    await readInstanceOperationsPolicy(context.config),
  );

  app.get("/api/v1/system/backups", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
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

  app.post("/api/v1/system/backups/manual", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!context.config.backupEnabled) {
      return reply.code(503).send({
        detail: "Backup service not running — set BACKUP_ENABLED=true to enable",
      });
    }
    try {
      const backupService = await service();
      const archivePath = await backupService.createBackup("manual");
      await backupService.pruneOldBackups();
      return reply.code(202).send({
        status: "ok",
        backup: archivePath.split("/").pop() ?? archivePath,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
