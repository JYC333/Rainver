import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { RunMaterializationService } from "../runs/materializationService.js";
import { isHardTerminalRunStatus } from "../runs/orchestrationResults.js";
import { PgRunRepository } from "../runs/repository.js";

export function registerExperimentReconcileHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  // Old deployments left these Jobs behind. Re-enter the durable finalizer;
  // new dispatches settle the Experiment without scheduling a second Job.
  registry.register("managed_experiment_reconcile", async job => {
    const runId = typeof job.payload.run_id === "string" ? job.payload.run_id : "";
    if (!runId) throw new Error("managed_experiment_reconcile requires run_id");
    const run = await new PgRunRepository(getDbPool(config.databaseUrl!)).getRun(job.space_id, runId);
    if (!run || !isHardTerminalRunStatus(run.status)) return {status: "skipped"};
    return await RunMaterializationService.fromConfig(config).finalizeRun(run);
  });
}
