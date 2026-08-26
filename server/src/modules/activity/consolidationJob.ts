import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { PgActivityConsolidationRepository } from "./consolidationRepository.js";

export function registerMemoryConsolidationHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const db = getDbPool(config.databaseUrl);
  registry.register("memory_consolidation", async (job) => {
    const spaceId = stringValue(job.payload.space_id) ?? job.space_id;
    const userId = stringValue(job.payload.user_id) ?? job.user_id;
    if (!spaceId) throw new Error("memory_consolidation job payload is missing space_id");
    if (!userId) throw new Error("memory_consolidation job payload is missing user_id");
    const batchLimit = numberValue(job.payload.batch_limit) ?? 50;
    const rawIds = job.payload.activity_ids;
    const activityIds =
      Array.isArray(rawIds) && rawIds.length > 0
        ? rawIds.map((value) => String(value))
        : null;
    const repo = new PgActivityConsolidationRepository(db);
    return repo.runPending({
      spaceId,
      actingUserId: userId,
      batchLimit,
      activityIds,
    });
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
