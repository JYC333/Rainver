import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { JobEnvelopeForHandler, JobHandlerRegistry, JobHandlerResult } from "../jobs/handlerRegistry";
import { SOURCE_ANNOTATION_JOB_TYPE } from "./repository";
import { SourceAnnotationService, type AnnotationSweepResult } from "./service";

export function registerSourceAnnotationHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  registry.register(SOURCE_ANNOTATION_JOB_TYPE, async (job) => handleSourceAnnotationJob(job, config));
}

/**
 * Drains a space's pending annotation queue.
 *
 * One job processes batches until the queue is empty or the pass stops making
 * progress. A scan that materializes 40 items enqueues one job, and requeueing
 * per batch would multiply jobs for what is one unit of work; stopping after a
 * single batch would leave 30 items waiting for the next scan.
 */
async function handleSourceAnnotationJob(
  job: JobEnvelopeForHandler,
  config: ServerConfig,
): Promise<JobHandlerResult> {
  const db = getDbPool(config.databaseUrl!);
  const service = new SourceAnnotationService(db, config);
  const results: AnnotationSweepResult[] = [];
  let annotated = 0;
  let skipped = 0;
  let failed = 0;
  for (let pass = 0; pass < MAX_PASSES_PER_JOB; pass += 1) {
    const result = await service.annotatePendingBatch(job.space_id);
    if (result.status === "no_work") break;
    results.push(result);
    annotated += result.annotated;
    skipped += result.skipped;
    failed += result.failed;
    // A blocked batch means the whole space cannot proceed right now (no
    // provider, denied egress, failing runs). Continuing would burn the
    // remaining passes reproducing the same failure against fresh items.
    if (result.status === "blocked") break;
  }
  return {
    space_id: job.space_id,
    passes: results.length,
    annotated,
    skipped,
    failed,
    last_status: results.at(-1)?.status ?? "no_work",
    ...(results.at(-1)?.reason ? { reason: results.at(-1)!.reason } : {}),
  };
}

const MAX_PASSES_PER_JOB = 20;
