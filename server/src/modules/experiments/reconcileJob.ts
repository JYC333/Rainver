import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry";
import { ExperimentRunService } from "./runService";

export function registerExperimentReconcileHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  registry.register("managed_experiment_reconcile", async job => {
    const runId = typeof job.payload.run_id === "string" ? job.payload.run_id : "";
    if (!runId) throw new Error("managed_experiment_reconcile requires run_id");
    const reconciled = await new ExperimentRunService(getDbPool(config.databaseUrl!)).reconcileManagedRun(job.space_id, runId);
    return { status: "succeeded", reconciled };
  });
}
