import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { EVOLVABLE_ASSET_EVALUATION_JOB, EvaluationHarnessService } from "./evaluationHarnessService.js";

export function registerEvaluationHarnessHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  registry.register(EVOLVABLE_ASSET_EVALUATION_JOB, async (job) => {
    const evaluationRunId = stringValue(job.payload.evaluation_run_id);
    const evaluationCaseId = stringValue(job.payload.evaluation_case_id);
    const assetId = stringValue(job.payload.asset_id);
    const candidateVersionId = stringValue(job.payload.candidate_version_id);
    const candidateRunId = stringValue(job.payload.candidate_run_id);
    if (!evaluationRunId || !evaluationCaseId || !assetId || !candidateVersionId || !candidateRunId) {
      throw new Error("evolvable_asset_evaluation job payload is incomplete");
    }
    if (!config.databaseUrl) throw new Error("evolvable asset evaluation requires SERVER_DATABASE_URL");
    return new EvaluationHarnessService(getDbPool(config.databaseUrl)).executeEvaluation({
      evaluationRunId,
      evaluationCaseId,
      assetId,
      candidateVersionId,
      candidateRunId,
    });
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
