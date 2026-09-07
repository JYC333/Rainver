import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { DeploymentService } from "./service.js";

/**
 * The soft drain (ADR 0020 §4).
 *
 * While an instance update is queued or draining, unattended work waits so the
 * drain can converge. Everything that has to make that decision consults the
 * one predicate here; nothing else in the server asks the question, and no
 * automation target knows deployment exists.
 */

/**
 * Trigger origins an update defers; conversation Runs keep running.
 *
 * Compared against a Run's *effective* origin, not the raw column: a delegated
 * child carries `delegation` and inherits the question from its root
 * (`effectiveTriggerOrigin`).
 */
export const DRAINED_TRIGGER_ORIGINS: ReadonlySet<string> = new Set([
  "automation",
  "autonomous",
  "job",
  "system",
]);

export const INSTANCE_UPDATE_PENDING = "instance_update_pending";

/**
 * Job families that create and start an unattended Run themselves instead of
 * enqueueing `agent_run`. They are deferred by job type because the decision
 * cannot be read off a Run that does not exist yet; `agent_run` is decided by
 * the Run's own trigger origin.
 *
 * Together with the automation scheduler these stop every unattended Run that
 * would occupy the instance for any length of time. They are deliberately not
 * a claim that no row appears in `runs`: a workflow action node still records
 * its own already-terminal Run through `createRunningSystemRun`, and a
 * research pipeline job still creates the queued Runs whose dispatch then
 * defers. Neither keeps the drain from converging.
 */
export const UNATTENDED_RUN_JOB_TYPES: readonly string[] = [
  "daily_capture_report",
  "source_post_processing_event",
  "source_annotation_event",
];

/** True while an `update` job is queued or draining. */
export async function instanceUpdatePending(config: ServerConfig): Promise<boolean> {
  if (!config.databaseUrl) return false;
  return new DeploymentService(getDbPool(config.databaseUrl), config.rainverEnv).updatePending();
}
