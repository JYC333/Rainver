import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobEnvelopeForHandler, JobHandlerRegistry, JobHandlerResult } from "../jobs/handlerRegistry.js";
import { SOURCE_ANNOTATION_JOB_TYPE } from "./repository.js";
import { SourceAnnotationService, type AnnotationSweepResult } from "./service.js";

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
  const pool = getDbPool(config.databaseUrl!);
  // One pass per space at a time, across workers: a manual retry's job beside
  // a sweep's, or two scans' jobs, would otherwise load the same pending batch
  // and pay for it twice. Held on a dedicated session for the whole drain.
  const lock = await pool.connect();
  const key = `source_annotation:${job.space_id}`;
  try {
    const acquired = await lock.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [key],
    );
    if (!acquired.rows[0]?.locked) {
      return { space_id: job.space_id, passes: 0, annotated: 0, skipped: 0, failed: 0, last_status: "already_running" };
    }
    try {
      return await drainSpace(job, config);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
    }
  } finally {
    lock.release();
  }
}

async function drainSpace(
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
