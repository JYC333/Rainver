import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry";
import { PgContextDigestService } from "./digestService";

export function registerContextDigestRefreshHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const db = getDbPool(config.databaseUrl);
  registry.register("context_digest_refresh", async (job) => {
    // space_id is authoritative from the job envelope (the trusted container),
    // never from the free-form payload. A payload carrying a different space_id
    // is a boundary violation: fail closed instead of operating cross-space.
    const spaceId = job.space_id;
    if (!spaceId) throw new Error("context_digest_refresh missing envelope space_id");
    const payloadSpaceId = stringValue(job.payload.space_id);
    if (payloadSpaceId && payloadSpaceId !== spaceId) {
      throw new Error(
        "context_digest_refresh payload space_id does not match envelope space_id",
      );
    }
    const digestType = stringValue(job.payload.digest_type) ?? "policy_bundle";
    const scopeId = stringValue(job.payload.scope_id);

    const service = new PgContextDigestService(db);
    if (digestType === "policy_bundle") {
      return service.generatePolicyBundle(spaceId) as unknown as Promise<Record<string, unknown>>;
    }
    if (digestType === "project_folder") {
      if (!scopeId) throw new Error("context_digest_refresh project_folder payload missing scope_id");
      return service.generateProjectFolderBundle(spaceId, scopeId) as unknown as Promise<Record<string, unknown>>;
    }
    if (digestType === "agent") {
      if (!scopeId) throw new Error("context_digest_refresh agent payload missing scope_id");
      return service.generateAgentBundle(spaceId, scopeId) as unknown as Promise<Record<string, unknown>>;
    }
    throw new Error(`unsupported digest_type for context_digest_refresh: ${JSON.stringify(digestType)}`);
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
