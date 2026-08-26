import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { KnowledgeExtractionService } from "./extractionService.js";

export function registerKnowledgeExtractionHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  registry.register("knowledge_candidate_extraction_reconcile", async job => {
    const runId = typeof job.payload.run_id === "string" ? job.payload.run_id : "";
    if (!runId) throw new Error("knowledge_candidate_extraction_reconcile requires run_id");
    const created = await new KnowledgeExtractionService(getDbPool(config.databaseUrl!)).reconcile(job.space_id, runId);
    return { status: "succeeded", created_candidates: created };
  });
}
