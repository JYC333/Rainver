import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import type { JobHandlerRegistry } from "../../jobs/handlerRegistry.js";
import { ManagedSemanticCheckpointProvider } from "./semanticExtractor.js";
import { RuntimeContextContinuityService } from "./service.js";

export const RUNTIME_CONTEXT_CHECKPOINT_JOB = "runtime_context_checkpoint";

export function registerRuntimeContextCheckpointHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const db = getDbPool(config.databaseUrl);
  const continuity = new RuntimeContextContinuityService(
    db,
    new ManagedSemanticCheckpointProvider(db, config),
  );
  registry.register(RUNTIME_CONTEXT_CHECKPOINT_JOB, async (job) => {
    const scopeId = stringValue(job.payload.work_context_scope_id);
    if (!scopeId) throw new Error(`${RUNTIME_CONTEXT_CHECKPOINT_JOB} missing work_context_scope_id`);
    const recovered = await continuity.recoverOpenCaptureGaps(job.space_id, scopeId);
    const captureStatus = await continuity.reconcileScope(job.space_id, scopeId);
    if (captureStatus === "partial") {
      throw new Error("Runtime Context capture remains partial after reconciliation");
    }
    const checkpoint = await continuity.runSemanticExtraction({
      spaceId: job.space_id,
      workContextScopeId: scopeId,
    });
    return { recovered_gaps: recovered, semantic_checkpoint_id: checkpoint?.id ?? null };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
