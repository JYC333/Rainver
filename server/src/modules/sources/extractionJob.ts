import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { SourceExtractionWorker } from "./extractionWorker.js";

export function registerSourceExtractionHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  registry.register("source_extraction", async (job) => {
    const extractionJobId = stringValue(job.payload.extraction_job_id);
    if (!extractionJobId) {
      throw new Error("source_extraction job payload requires extraction_job_id");
    }
    const worker = new SourceExtractionWorker(getDbPool(config.databaseUrl!), config);
    const result = await worker.runPendingJob(extractionJobId, job.space_id);
    return {
      extraction_job_id: result.id,
      status: result.status,
      job_type: result.job_type,
    };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
